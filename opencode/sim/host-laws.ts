// The host laws: what OpenCode does for a plugin, each law over the plugin
// context's own operations, written once against the fork's `Plugin.Context`
// and run on both hosts by the law probe (sim/server.ts), a plugin that runs
// every law from inside the host. sim/host-laws.test.ts loads it into the
// world; tests/host-laws.test.ts into real OpenCode (tests/host-laws/real.ts), on a
// scripted model that answers as law-names.ts `answer` says.
//
// Every operation the world's context offers (context.ts OPERATIONS) is named
// by at least one law (sim/host-laws.test.ts holds that), so no world
// behaviour a plugin can reach stands without a law real OpenCode also passes.
//
// A law reads the host only through the context: what it answers, the events
// it publishes and the hooks it runs. The probe (`probeOf`) is made of the
// same: it counts each session's executions from the host's events and the
// model's requests from the `model.request` hook.
import { Integration, type Plugin, Tool } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Array as Arr, Cause, Data, DateTime, Effect, Exit, Option, Ref, Schema, type Scope, Stream } from "effect"
import type { OPERATIONS } from "./context.ts"
import {
  CLIENT,
  ELSEWHERE_FOLDER,
  KEPT_IN_SUMMARY,
  LAW,
  LAW_FOLDER,
  lawCall,
  LAW_LOGIN,
  LAW_MOVED,
  LAW_SOL,
  LAW_SHELL,
  LAW_SOCKET,
  RATE_LIMITED,
  REFUSAL,
  REFUSED,
  REPAIRED,
  SPAWNED,
  UNAUTHORIZED,
  USAGE_LIMITED,
} from "./law-names.ts"

/** The agents the laws define: one for the agent law, a subagent for the subagent laws, one with a small window. */
const LAW_AGENT = "law-agent"
const LAW_CHILD = "law-child"
const LAW_WINDOW = "law-window"
/**
 * The window law's compaction window, in tokens: under twice the 16k reserve, so its ceiling is 85% of it (85), which
 * a request on either host's law model passes (the world's answer reports 100 input tokens, real OpenCode's 1,010).
 */
const WINDOW_TOKENS = 100

/** A tool result's content as text, for a wrapper to put a line before it. */
const resultContent = (content: Tool.Result["content"]) => {
  if (Schema.is(Schema.String)(content)) return content
  const texts: Array<string> = []
  for (const part of content ?? []) if (part.type === "text") texts.push(part.text)
  return texts.join("\n")
}

export type Operation = (typeof OPERATIONS)[number]

/** A law broken: what was expected and what the host did. */
export class LawBroken extends Data.TaggedError("LawBroken")<{ readonly message: string }> {}

/** What a law reads beside the context's answers: the model's requests and when a session is at rest. */
export interface Probe {
  /** The model's requests so far, as the `model.request` hook saw them. */
  readonly requests: Effect.Effect<ReadonlyArray<{ readonly sessionID: string; readonly kind: string }>>
  /** Runs `action`, then waits until the session ran an execution after it and has none running. */
  readonly turn: <A, E>(sessionID: string, action: Effect.Effect<A, E>) => Effect.Effect<A, E | LawBroken>
  /** Asks the host's client to act (law-names.ts `CLIENT`); the law waits for what the host does after. */
  readonly client: (ask: ClientAsk) => Effect.Effect<void>
}

/** What a law asks the host's client to do. */
export const ClientAsk = Schema.Union([
  Schema.Struct({ action: Schema.Literal("archive"), sessionID: Schema.String }),
  Schema.Struct({ action: Schema.Literal("form"), sessionID: Schema.String, key: Schema.String, value: Schema.String }),
])
export type ClientAsk = typeof ClientAsk.Type
const encodeAsk = Schema.encodeSync(Schema.fromJsonString(ClientAsk))

/** Waits until `holds` answers true, polling the host's clock; fails the law with `message` past 30 s. */
const waitFor = <E>(holds: Effect.Effect<boolean, E>, message: string) =>
  Effect.gen(function* () {
    for (let waited = 0; !(yield* holds); waited += 100) {
      if (waited > 30_000) return yield* Effect.fail(new LawBroken({ message }))
      yield* Effect.sleep("100 millis")
    }
  })

export interface Law {
  readonly name: string
  readonly operations: ReadonlyArray<Operation>
  readonly check: (ctx: Plugin.Context, probe: Probe) => Effect.Effect<void, unknown, Scope.Scope>
}

/** Fails the law with `message` unless `holds`. */
const ensure = (holds: boolean, message: string) => {
  if (holds) return Effect.void
  return Effect.fail(new LawBroken({ message }))
}

/** The probe on a plugin's context: subscribed to executions and hooked on requests for the plugin's life. */
export const probeOf = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    const running = yield* Ref.make<ReadonlySet<string>>(new Set())
    const requests = yield* Ref.make<ReadonlyArray<{ readonly sessionID: string; readonly kind: string }>>([])
    yield* ctx.session.hook("model.request", (input) => Ref.update(requests, (all) => [...all, { sessionID: input.sessionID, kind: input.kind }]))
    yield* Effect.forkScoped(
      ctx.event
        .subscribe({ types: ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })
        .pipe(
          Stream.runForEach((event) => {
            const id: string = event.data.sessionID
            if (event.type === "session.execution.started")
              return Ref.update(starts, (all) => new Map([...all, [id, (all.get(id) ?? 0) + 1]])).pipe(
                Effect.andThen(Ref.update(running, (all) => new Set([...all, id]))),
              )
            return Ref.update(running, (all) => new Set([...all].filter((other) => other !== id)))
          }),
        ),
      { startImmediately: true },
    )
    const startsOf = (sessionID: string) => Ref.get(starts).pipe(Effect.map((all) => all.get(sessionID) ?? 0))
    const busy = (sessionID: string) => Ref.get(running).pipe(Effect.map((all) => all.has(sessionID)))
    /** At rest: an execution started since `before`, none runs, and none starts within a second. */
    const rested = (sessionID: string, before: number) =>
      Effect.gen(function* () {
        if ((yield* startsOf(sessionID)) <= before || (yield* busy(sessionID))) return false
        yield* Effect.sleep("1 second")
        return !(yield* busy(sessionID))
      })
    const turn = <A, E>(sessionID: string, action: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const before = yield* startsOf(sessionID)
        const result = yield* action
        for (let waited = 0; !(yield* rested(sessionID, before)); waited += 100) {
          if (waited > 60_000) return yield* Effect.fail(new LawBroken({ message: `session ${sessionID} ran no execution to its end within 60 s` }))
          yield* Effect.sleep("100 millis")
        }
        return result
      })
    const client = (ask: ClientAsk) => Effect.logInfo(`${CLIENT}${encodeAsk(ask)}`)
    const probe: Probe = { requests: Ref.get(requests), turn, client }
    return probe
  })

/** A law call's input: a JSON object, as its text. */
const CallInput = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
/** A law's prompt that asks the model to call `tool` with `input`. */
const callFor = (tool: string, input: typeof CallInput.Type) => lawCall(tool, Schema.encodeSync(CallInput)(input))

const fresh = (ctx: Plugin.Context) => ctx.session.create({ title: "law" })

/** A session as `session.get` answers it. */
type SessionInfo = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
/** A compaction's ended event's summary (a started one has none). */
const Summary = Schema.Struct({ text: Schema.String })
/** A text part of an assistant message's content. */
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
/** An assistant message of a session's context, by its content's parts. */
const AssistantText = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
})

/** What a session's context holds, as one JSON text, for a law to look into. */
const contextText = (ctx: Plugin.Context, sessionID: SessionID) =>
  ctx.session.context({ sessionID }).pipe(Effect.flatMap((messages) => Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(messages)))

const count = (text: string, part: string) => text.split(part).length - 1

/** A provider's socket frame's event type, as OpenAI's Responses names it, or `?` for a frame that names none. */
const frameType = (frame: string) =>
  Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.String })))(frame), {
    onNone: () => "?",
    onSome: (event) => event.type,
  })

/** A shell call's command, from a tool call's input as a hook sees it: none when the input is not an object holding one. */
const decodeCommand = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))

/** A provider's 429 with `body`, as the law puts it in place of an answer. */
const limited = (body: string) => new Response(body, { status: 429, headers: { "content-type": "application/json" } })

/** A short wait on the host's clock: long enough for work that would start to start. */
const settle = Effect.sleep("2 seconds")

/** A gap on the host's clock between two session writes, so their update times differ (the store keeps ms). */
const STEP = "20 millis"

/** A session list's "no parent", as the fork's API takes it and idle compaction asks for its roots (JSON null). */
const ROOT = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")

/** The law's RPC: one method that answers its input. */
const LAW_RPC = {
  id: "dotfiles-opencode.sim-law",
  methods: { echo: { input: { type: "object" }, output: { type: "object" } } },
  events: {},
}

/** A law's RPC whose handlers break: one dies, one never answers. */
const LAW_FAULT_RPC = {
  id: "dotfiles-opencode.sim-law-faults",
  methods: { dies: { input: { type: "object" }, output: { type: "object" } }, hangs: { input: { type: "object" }, output: { type: "object" } } },
  events: {},
}

export const LAWS: ReadonlyArray<Law> = [
  {
    name: LAW.storage,
    operations: ["storage.get", "storage.set", "storage.remove", "storage.scan"],
    check: (ctx) =>
      Effect.gen(function* () {
        for (const key of ["law:c", "law:a", "law:b", "other:z"]) yield* ctx.storage.set(key, { key })
        yield* ensure(Schema.is(Schema.Struct({ key: Schema.Literal("law:a") }))(yield* ctx.storage.get("law:a")), "get answered another value")
        const first = yield* ctx.storage.scan({ prefix: "law:", limit: 2 })
        const keys = first.entries.map((entry) => entry.key).join(",")
        yield* ensure(keys === "law:a,law:b", `the first page held ${keys}`)
        yield* ensure(first.next === "law:b", `the first page's next was ${String(first.next)}`)
        const second = yield* ctx.storage.scan({ prefix: "law:", after: first.next ?? "", limit: 2 })
        yield* ensure(second.entries.map((entry) => entry.key).join(",") === "law:c", `the second page held ${second.entries.length} entries`)
        yield* ensure(Option.isNone(Option.fromNullishOr(second.next)), "the last page has a next")
        yield* ctx.storage.remove("law:a")
        yield* ensure(Option.isNone(Option.fromNullishOr(yield* ctx.storage.get("law:a"))), "a removed key still answered")
      }),
  },
  {
    name: LAW.prompt,
    operations: ["session.create", "session.prompt", "session.get", "session.context", "event.subscribe"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const session = yield* fresh(ctx)
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["session.inbox.enqueued", "session.inbox.delivered"] }).pipe(
            Stream.runForEach((event) =>
              Effect.when(
                Ref.update(seen, (all) => [...all, event.type]),
                Effect.succeed(event.data.sessionID === session.id),
              ),
            ),
          ),
          { startImmediately: true },
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: prompt" }))
        const events = (yield* Ref.get(seen)).join(",")
        yield* ensure(events === "session.inbox.enqueued,session.inbox.delivered", `the inbox events were ${events}`)
        const primary = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(primary.length === 1, `the prompt brought ${primary.length} requests`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard prompt") === 1, "the session does not hold the model's answer to the prompt")
        // The answer is the assistant message's text content, as a plugin reads a session's last words.
        const answers = (yield* ctx.session.context({ sessionID: session.id })).flatMap((message) =>
          Option.toArray(Schema.decodeUnknownOption(AssistantText)(message)).flatMap((assistant) => assistant.content.flatMap((part) => Option.toArray(Option.liftPredicate(part, Schema.is(TextPart))).map((text) => text.text))),
        )
        yield* ensure(answers.includes("heard prompt"), `the assistant's text content was ${answers.join(" / ")}`)
        const info = yield* ctx.session.get({ sessionID: session.id })
        yield* ensure(info.id === session.id, "get answered another session")
        // A prompt with an id (wake's): a second admission of the id is not taken again.
        const once = { sessionID: session.id, id: SessionMessage.ID.make("msg_lawpromptonce001"), text: "law: prompt once" }
        yield* probe.turn(session.id, ctx.session.prompt(once))
        yield* ctx.session.prompt(once).pipe(Effect.ignore)
        yield* settle
        const asked = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(asked.length === 2, `the two prompts, the second with a repeated id, brought ${asked.length} requests`)
        const held = count(yield* contextText(ctx, session.id), "law: prompt once")
        yield* ensure(held === 1, `the session holds the prompt with an id ${held} times`)
      }),
  },
  {
    name: LAW.steer,
    operations: ["session.synthetic", "session.context"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        // As wake and questions steer a letter: an id, a description, metadata and `delivery: "steer"`, the host's default.
        const steer = ctx.session.synthetic({
          sessionID: session.id,
          id: SessionMessage.ID.make("msg_lawsteeronce0001"),
          text: "law: steer once",
          description: "law",
          metadata: { law: "steer" },
          delivery: "steer",
          resume: true,
        })
        yield* probe.turn(session.id, steer)
        yield* steer.pipe(Effect.ignore)
        yield* settle
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "heard steer once") === 1, `the model answered the steer ${count(text, "heard steer once")} times`)
        yield* ensure(count(text, "law: steer once") === 1, `the session holds the steer ${count(text, "law: steer once")} times`)
        const kept = (yield* ctx.session.context({ sessionID: session.id })).filter((message) =>
          Schema.is(Schema.Struct({ type: Schema.Literal("synthetic"), metadata: Schema.Struct({ law: Schema.Literal("steer") }) }))(message),
        )
        yield* ensure(kept.length === 1, `${kept.length} synthetic messages keep the steer's metadata`)
      }),
  },
  {
    name: LAW.notice,
    operations: ["session.synthetic", "session.prompt"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        yield* ctx.session.synthetic({ sessionID: session.id, text: "law: read me later", description: "law", resume: false })
        yield* settle
        const asked = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(asked.length === 0, "a synthetic message without resume started a turn")
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: now" }))
        yield* ensure(count(yield* contextText(ctx, session.id), "heard read me later|now") === 1, "the next turn did not read the waiting message")
      }),
  },
  {
    name: LAW.compact,
    operations: ["session.compact", "session.context", "session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const idles = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.session.hook("experimental.idle", (input) => Ref.update(idles, (all) => [...all, input.sessionID]))
        const session = yield* fresh(ctx)
        const ran = Ref.get(idles).pipe(Effect.map((all) => all.filter((id) => id === session.id).length))
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: before the compaction" }))
        yield* ensure((yield* ran) === 1, "experimental.idle did not run once after one turn")
        yield* probe.turn(session.id, ctx.session.compact({ sessionID: session.id, reason: "auto" }))
        const compactions = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "compaction")
        yield* ensure(compactions.length === 1, `the compaction asked the model ${compactions.length} times`)
        const messages = yield* ctx.session.context({ sessionID: session.id })
        const first = Schema.decodeUnknownOption(
          Schema.Struct({ type: Schema.Literal("compaction"), status: Schema.Literal("completed"), reason: Schema.Literal("auto") }),
        )(messages[0])
        yield* ensure(Option.isSome(first), "the context does not start at a completed automatic compaction")
        yield* ensure((yield* ran) === 1, "experimental.idle ran after the compaction alone")
      }),
  },
  {
    name: LAW.request,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: hooked" }))
        const kinds = (yield* probe.requests).filter((request) => request.sessionID === session.id).map((request) => request.kind)
        yield* ensure(kinds.includes("primary"), `the hook saw ${kinds.join(",")}`)
      }),
  },
  {
    // Both hosts run with `experimental.schedules` on, so the schedule tools are built in.
    name: LAW.tools,
    operations: ["tool.transform", "tool.list"],
    check: (ctx) =>
      Effect.gen(function* () {
        const before = (yield* ctx.tool.list()).map((tool) => tool.id)
        yield* ensure(before.includes("opencode_schedule_create"), `the built-in tools were ${before.join(",")}`)
        yield* ctx.tool.transform((editor) => {
          editor.add({
            name: "law_echo",
            description: "echoes",
            input: Schema.Struct({ text: Schema.String }),
            execute: (input) => Effect.succeed({ content: input.text }),
          })
          editor.remove("opencode_schedule_create")
        })
        const after = (yield* ctx.tool.list()).map((tool) => tool.id)
        yield* ensure(after.includes("law_echo"), "the added tool is not offered")
        yield* ensure(!after.includes("opencode_schedule_create"), "the removed tool is offered")
      }),
  },
  {
    name: LAW.rpc,
    operations: ["rpc", "rpc.register"],
    check: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.rpc.register(LAW_RPC, { echo: (input) => Effect.succeed({ echoed: input }) })
        const reply = yield* ctx.rpc(LAW_RPC).echo({ text: "law: rpc" })
        yield* ensure(Schema.is(Schema.Struct({ echoed: Schema.Struct({ text: Schema.Literal("law: rpc") }) }))(reply), "the RPC answered something else")
      }),
  },
  {
    name: LAW.rpcFaults,
    operations: ["rpc", "rpc.register"],
    // What a plugin meets when another's handler breaks (the world's RPC faults make a handler do either).
    check: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.rpc.register(LAW_FAULT_RPC, { dies: () => Effect.die(new Error("law: the handler died")), hangs: () => Effect.never })
        const died = yield* Effect.exit(ctx.rpc(LAW_FAULT_RPC).dies({}))
        yield* ensure(Exit.isFailure(died) && !Cause.hasDies(died.cause), "a handler that died did not fail the call as a failure")
        const hung = yield* ctx.rpc(LAW_FAULT_RPC).hangs({}).pipe(Effect.timeoutOption("200 millis"))
        yield* ensure(Option.isNone(hung), "a handler that never answers answered")
      }),
  },
  {
    name: LAW.sessions,
    operations: ["session.create", "session.list", "session.get", "session.update", "session.prompt"],
    // Every argument our plugins pass to session.list (idle-compact: parentID, ROOT with directory,
    // order "desc", limit) and the key it sorts by: the last update (an update or an admitted prompt
    // bumps it), newest first by default.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const ids = (list: { readonly data: ReadonlyArray<{ readonly id: string }> }) => list.data.map((session) => session.id).join(",")
        // A session created as wake creates one: its own id, a location and metadata; created again, the same session.
        const chosen = { id: SessionID.make("ses_lawchosen0000001"), location: { directory: ctx.location.directory }, title: "law chosen", metadata: { law: "chosen" } }
        const made = yield* ctx.session.create(chosen)
        const again = yield* ctx.session.create({ ...chosen, metadata: { law: "again" } })
        const found = yield* ctx.session.get({ sessionID: chosen.id })
        yield* ensure(made.id === chosen.id && again.id === chosen.id, `create with an id answered ${made.id} and ${again.id}`)
        yield* ensure(found.location.directory === ctx.location.directory, `the chosen session is in ${found.location.directory}`)
        yield* ensure(Schema.is(Schema.Struct({ law: Schema.Literal("chosen") }))(found.metadata), "the chosen session's metadata is not the first create's")
        const parent = yield* fresh(ctx)
        const older = yield* ctx.session.create({ parentID: parent.id, title: "law older child" })
        yield* Effect.sleep(STEP)
        const newer = yield* ctx.session.create({ parentID: parent.id, title: "law newer child" })
        const children = yield* ctx.session.list({ parentID: parent.id })
        yield* ensure(ids(children) === `${newer.id},${older.id}`, `with no order the children were ${ids(children)}, not the newer child first`)
        const roots = yield* ctx.session.list({ parentID: ROOT, directory: ctx.location.directory })
        yield* ensure(
          roots.data.some((session) => session.id === parent.id),
          "the roots miss the parent",
        )
        yield* ensure(!roots.data.some((session) => session.id === older.id), "the roots list a child")
        const elsewhere = yield* ctx.session.list({ parentID: ROOT, directory: AbsolutePath.make(`${ctx.location.directory}-elsewhere`) })
        yield* ensure(!elsewhere.data.some((session) => session.id === parent.id), "the roots of another directory list the parent")
        yield* Effect.sleep(STEP)
        yield* ctx.session.update({ sessionID: older.id, metadata: { law: "kept" } })
        const info = yield* ctx.session.get({ sessionID: older.id })
        yield* ensure(Schema.is(Schema.Struct({ law: Schema.Literal("kept") }))(info.metadata), "get does not answer the updated metadata")
        const latest = yield* ctx.session.list({ parentID: parent.id, order: "desc", limit: 1 })
        yield* ensure(ids(latest) === older.id, `desc limit 1 after the older child's update was ${ids(latest)}, not the updated child`)
        const ascending = yield* ctx.session.list({ parentID: parent.id, order: "asc" })
        yield* ensure(ids(ascending) === `${newer.id},${older.id}`, `asc after the update was ${ids(ascending)}`)
        yield* Effect.sleep(STEP)
        yield* probe.turn(newer.id, ctx.session.prompt({ sessionID: newer.id, text: "law: list order" }))
        const prompted = yield* ctx.session.list({ parentID: parent.id, order: "desc", limit: 1 })
        yield* ensure(ids(prompted) === newer.id, `desc limit 1 after a prompt to the newer child was ${ids(prompted)}`)
      }),
  },
  {
    name: LAW.steps,
    operations: ["event.subscribe", "session.prompt", "session.context"],
    // The pool prices a step from its end and its model from its start, and listens for session.idle.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["session.step.started", "session.step.ended", "session.idle"] }).pipe(
            Stream.runForEach((event) => {
              if (event.type === "session.idle") return Ref.update(seen, (all) => [...all, "idle"])
              if (event.data.sessionID !== session.id) return Effect.void
              if (event.type === "session.step.started") {
                const { agent, model, assistantMessageID } = event.data
                return Ref.update(seen, (all) => [...all, `started ${assistantMessageID} ${agent} ${model.providerID}/${model.id}`])
              }
              return Ref.update(seen, (all) => [...all, `ended ${event.data.assistantMessageID}`])
            }),
          ),
          { startImmediately: true },
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: steps" }))
        yield* settle
        const assistant = (yield* ctx.session.context({ sessionID: session.id })).flatMap((message) => {
          if (message.type === "assistant") return [message.id]
          return []
        })
        yield* ensure(assistant.length === 1, `the turn holds ${assistant.length} assistant messages`)
        const lines = (yield* Ref.get(seen)).join(", ")
        yield* ensure(lines === `started ${assistant[0]} build sim/sim-model, ended ${assistant[0]}`, `the step events were ${lines}`)
      }),
  },
  {
    name: LAW.removed,
    operations: ["session.remove", "event.subscribe", "session.get"],
    check: (ctx) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const deleted = yield* Ref.make(0)
        yield* Effect.forkScoped(
          ctx.event
            .subscribe({ types: ["session.deleted"] })
            .pipe(Stream.runForEach((event) => Effect.when(Ref.update(deleted, (n) => n + 1), Effect.succeed(event.data.sessionID === session.id)))),
          { startImmediately: true },
        )
        yield* ctx.session.remove({ sessionID: session.id })
        yield* settle
        yield* ensure((yield* Ref.get(deleted)) === 1, `the removal published session.deleted ${yield* Ref.get(deleted)} times`)
        const gone = yield* Effect.exit(ctx.session.get({ sessionID: session.id }))
        yield* ensure(gone._tag === "Failure", "get still answers a removed session")
      }),
  },
  {
    name: LAW.archived,
    operations: ["session.update", "event.subscribe", "session.list"],
    // Questions forgets an archived session's questions: the owner archives it, from a client. Mail lists the
    // sessions it may deliver to with `archived: false`.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const archived = yield* Ref.make(0)
        yield* Effect.forkScoped(
          ctx.event
            .subscribe({ types: ["session.archived"] })
            .pipe(Stream.runForEach((event) => Effect.when(Ref.update(archived, (n) => n + 1), Effect.succeed(event.data.sessionID === session.id)))),
          { startImmediately: true },
        )
        yield* ctx.session.update({ sessionID: session.id, archived: true })
        yield* settle
        yield* ensure((yield* Ref.get(archived)) === 0, "a plugin's update archived the session")
        yield* probe.client({ action: "archive", sessionID: session.id })
        yield* waitFor(
          Ref.get(archived).pipe(Effect.map((n) => n > 0)),
          "the client's archive published no session.archived",
        )
        yield* probe.client({ action: "archive", sessionID: session.id })
        yield* settle
        yield* ensure((yield* Ref.get(archived)) === 1, `archiving twice published session.archived ${yield* Ref.get(archived)} times`)
        const kept = yield* fresh(ctx)
        const listed = (archivedOnly: boolean) =>
          ctx.session.list({ parentID: null, archived: archivedOnly, order: "desc", limit: 100 }).pipe(Effect.map((page) => page.data.map((info) => info.id)))
        const live = yield* listed(false)
        yield* ensure(live.includes(kept.id) && !live.includes(session.id), "a list with archived: false did not leave out only the archived session")
        const gone = yield* listed(true)
        yield* ensure(gone.includes(session.id) && !gone.includes(kept.id), "a list with archived: true did not list only the archived session")
      }),
  },
  {
    name: LAW.form,
    operations: ["event.subscribe"],
    // Questions hears the owner's answers to its form from form.replied.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const replies = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["form.replied"] }).pipe(
            Stream.runForEach((event) =>
              Ref.update(replies, (all) => [...all, `${event.data.sessionID === session.id} ${String(event.data.answer["law"])}`]),
            ),
          ),
          { startImmediately: true },
        )
        yield* probe.client({ action: "form", sessionID: session.id, key: "law", value: "answered" })
        yield* waitFor(
          Ref.get(replies).pipe(Effect.map((all) => all.length > 0)),
          "the client's answer published no form.replied",
        )
        yield* settle
        const seen = (yield* Ref.get(replies)).join(",")
        yield* ensure(seen === "true answered", `form.replied carried ${seen}`)
      }),
  },
  {
    name: LAW.agent,
    operations: ["agent.transform", "agent.get", "event.subscribe", "session.create", "session.get", "session.prompt", "session.hook"],
    // Wake creates a fire's session with the agent and model the alarm names.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const updates = yield* Ref.make(0)
        const asked = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.forkScoped(ctx.event.subscribe({ types: ["agent.updated"] }).pipe(Stream.runForEach(() => Ref.update(updates, (n) => n + 1))), {
          startImmediately: true,
        })
        yield* ctx.session.hook("model.request", (event) =>
          Ref.update(asked, (all) => [...all, `${event.sessionID} ${event.kind} ${event.agent} ${event.model.providerID}/${event.model.id}`]),
        )
        yield* ctx.agent.transform((editor) =>
          editor.update("law", (agent) => {
            agent.description = "law: an agent a plugin adds"
          }),
        )
        yield* settle
        yield* ensure((yield* Ref.get(updates)) >= 1, "adding an agent published no agent.updated")
        yield* ctx.agent.get({ agentID: Agent.ID.make("law"), location: { directory: ctx.location.directory } })
        const model = { providerID: Provider.ID.make("sim"), id: Model.ID.make("sim-model"), variant: Model.VariantID.make("default") }
        const session = yield* ctx.session.create({ title: "law agent", agent: Agent.ID.make("law"), model })
        const info = yield* ctx.session.get({ sessionID: session.id })
        yield* ensure(info.agent === "law", `the session's agent is ${String(info.agent)}`)
        yield* ensure(info.model?.providerID === "sim" && info.model.id === "sim-model", `the session's model is ${info.model?.providerID}/${info.model?.id}`)
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: agent" }))
        const mine = (yield* Ref.get(asked)).filter((line) => line.startsWith(`${session.id} primary `))
        yield* ensure(mine.join(",") === `${session.id} primary law sim/sim-model`, `the session's requests were ${mine.join(",")}`)
      }),
  },
  {
    name: LAW.socket,
    operations: ["session.create", "session.prompt", "session.hook"],
    // The pool reads a ChatGPT login's quota from the frames of a socket turn.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const frames = yield* Ref.make<ReadonlyArray<string>>([])
        const model = { providerID: Provider.ID.make(LAW_SOCKET.providerID), id: Model.ID.make(LAW_SOCKET.id) }
        const session = yield* ctx.session.create({ title: "law socket", model })
        yield* ctx.session.hook("experimental.ws.receive", (event) =>
          Ref.update(frames, (all) => [
            ...all,
            ...Arr.filter([`${event.kind} ${event.model.providerID}/${event.model.id} ${frameType(event.frame)}`], () => event.sessionID === session.id),
          ]),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: socket" }))
        const seen = yield* Ref.get(frames)
        const on = `primary ${LAW_SOCKET.providerID}/${LAW_SOCKET.id}`
        yield* ensure(seen.at(0) === `${on} response.created` && seen.at(-1) === `${on} response.completed`, `the frames were ${seen.join(",")}`)
        yield* ensure(seen.includes(`${on} response.output_text.delta`), `no text frame among ${seen.join(",")}`)
      }),
  },
  {
    name: LAW.catalog,
    operations: ["model.list", "model.default", "provider.list", "provider.get", "agent.list", "agent.get"],
    check: (ctx) =>
      Effect.gen(function* () {
        const location = { directory: ctx.location.directory }
        const models = yield* ctx.model.list({ location })
        yield* ensure(
          models.data.some((model) => model.providerID === "sim" && model.id === "sim-model"),
          "the model list lacks sim/sim-model",
        )
        // A model configured with a family and a release date lists both: the release as epoch ms.
        const sol = models.data.find((model) => model.providerID === "sim" && model.id === LAW_SOL.id)
        yield* ensure(
          sol?.family === LAW_SOL.family && sol.time?.released === Date.parse(LAW_SOL.releaseDate),
          `the model list gives sim/${LAW_SOL.id} the family ${sol?.family} and the release ${sol?.time?.released}`,
        )
        const chosen = (yield* ctx.model.default({ location })).data
        yield* ensure(chosen?.providerID === "sim" && chosen.id === "sim-model", `the default model is ${chosen?.providerID}/${chosen?.id}`)
        const providers = yield* ctx.provider.list({ location })
        yield* ensure(
          providers.data.some((provider) => provider.id === "sim"),
          "the provider list lacks sim",
        )
        yield* ctx.provider.get({ providerID: Provider.ID.make("sim"), location })
        const missing = yield* Effect.exit(ctx.provider.get({ providerID: Provider.ID.make("law-none"), location }))
        yield* ensure(missing._tag === "Failure", "a provider the host lacks was found")
        const agents = yield* ctx.agent.list({ location })
        yield* ensure(
          agents.data.some((agent) => agent.id === "build"),
          "the agent list lacks build",
        )
        yield* ctx.agent.get({ agentID: Agent.ID.make("build"), location })
        const none = yield* Effect.exit(ctx.agent.get({ agentID: Agent.ID.make("law-none"), location }))
        yield* ensure(none._tag === "Failure", "an agent the host lacks was found")
      }),
  },
  {
    name: LAW.http,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const mine = (sessionID: string) => sessionID === session.id
        yield* ctx.session.hook("model.request", (event) =>
          Effect.sync(() => {
            if (mine(event.sessionID)) event.headers["x-law-mark"] = "marked"
          }),
        )
        yield* ctx.session.hook("http.request", (event) =>
          Effect.gen(function* () {
            if (!mine(event.sessionID)) return
            yield* Ref.update(seen, (all) => [...all, `request ${event.kind} ${event.request.headers.get("x-law-mark") ?? "unmarked"}`])
            const headers = new Headers(event.request.headers)
            headers.set("x-law-second", "replaced")
            event.request = new Request(event.request, { headers })
          }),
        )
        yield* ctx.session.hook("http.response", (event) =>
          Effect.gen(function* () {
            if (!mine(event.sessionID)) return
            yield* Ref.update(seen, (all) => [...all, `response ${event.kind} ${event.request.headers.get("x-law-second") ?? "kept"} ${event.response.status}`])
          }),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: http" }))
        const lines = yield* Ref.get(seen)
        const primary = lines.filter((entry) => entry.includes(" primary "))
        yield* ensure(primary.join(",") === "request primary marked,response primary replaced 200", `the HTTP hooks saw ${lines.join(", ")}`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard http") === 1, "the replaced request was not answered")
      }),
  },
  {
    name: LAW.retry,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const answered = yield* Ref.make(0)
        const decisions = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.session.hook("http.response", (event) =>
          Effect.gen(function* () {
            if (event.sessionID !== session.id || event.kind !== "primary") return
            const index = yield* Ref.getAndUpdate(answered, (n) => n + 1)
            if (index === 0) event.response = limited(RATE_LIMITED)
            if (index === 1) event.response = limited(USAGE_LIMITED)
          }),
        )
        yield* ctx.session.hook("retry", (event) =>
          Effect.gen(function* () {
            if (event.sessionID !== session.id) return
            yield* Ref.update(decisions, (all) => [...all, String(event.decision.retry)])
            event.decision = { retry: true, delay: 0 }
          }),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: retry" }))
        const decided = (yield* Ref.get(decisions)).join(",")
        yield* ensure(decided === "true,false", `the retry hook saw the decisions ${decided}`)
        const primary = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(primary.length === 3, `model.request ran ${primary.length} times for the retried turn`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard retry") === 1, "the retried request was not answered once")
      }),
  },
  {
    name: LAW.refused,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const idles = yield* Ref.make(0)
        yield* ctx.session.hook("http.response", (event) =>
          Effect.sync(() => {
            if (event.sessionID === session.id && event.kind === "primary") event.response = limited(USAGE_LIMITED)
          }),
        )
        yield* ctx.session.hook("experimental.idle", (event) => Effect.when(Ref.update(idles, (n) => n + 1), Effect.succeed(event.sessionID === session.id)))
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: refused" }))
        const primary = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(primary.length === 1, `a refused turn made ${primary.length} requests`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard refused") === 0, "a refused turn was answered")
        yield* ensure((yield* Ref.get(idles)) === 0, "experimental.idle ran after a failed turn")
      }),
  },
  {
    name: LAW.died,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const retries = yield* Ref.make(0)
        yield* ctx.session.hook("http.request", (event) =>
          Effect.suspend(() => {
            if (event.sessionID === session.id && event.kind === "primary") return Effect.die(new Error("law: the hook died"))
            return Effect.void
          }),
        )
        yield* ctx.session.hook("retry", (event) => Effect.when(Ref.update(retries, (n) => n + 1), Effect.succeed(event.sessionID === session.id)))
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: died" }))
        const primary = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(primary.length === 1, `a turn whose hook died made ${primary.length} requests`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard died") === 0, "a turn whose hook died was answered")
        yield* ensure((yield* Ref.get(retries)) === 0, "the retry hook was asked about a hook that died")
      }),
  },
  {
    name: LAW.unauthorized,
    operations: ["session.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const answers = yield* Ref.make<ReadonlyArray<string>>([])
        const decisions = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.session.hook("http.request", (event) =>
          Effect.sync(() => {
            if (event.sessionID === session.id && event.kind === "primary")
              event.request = new Request("data:text/plain,law%3A%20offline", { method: "GET", signal: event.request.signal })
          }),
        )
        yield* ctx.session.hook("http.response", (event) =>
          Effect.gen(function* () {
            if (event.sessionID !== session.id || event.kind !== "primary") return
            const sent = event.response
            const text = yield* Effect.promise(() => sent.text())
            yield* Ref.update(answers, (all) => [...all, `${sent.status} ${text}`])
            event.response = new Response(UNAUTHORIZED, { status: 401, headers: { "content-type": "application/json" } })
          }),
        )
        yield* ctx.session.hook("retry", (event) =>
          Effect.when(
            Ref.update(decisions, (all) => [...all, `${event.decision.retry} ${event.error.message.includes("law: sign in again")}`]),
            Effect.succeed(event.sessionID === session.id),
          ),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: unauthorized" }))
        const answered = (yield* Ref.get(answers)).join(",")
        yield* ensure(answered === "200 law: offline", `the data: request was answered ${answered}`)
        const decided = (yield* Ref.get(decisions)).join(",")
        yield* ensure(decided === "false true", `the retry hook saw ${decided}`)
        const primary = (yield* probe.requests).filter((request) => request.sessionID === session.id && request.kind === "primary")
        yield* ensure(primary.length === 1, `a turn its 401 ended made ${primary.length} requests`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard unauthorized") === 0, "a turn its 401 ended was answered")
      }),
  },
  {
    name: LAW.integration,
    operations: ["integration.get", "integration.transform", "integration.connection"],
    check: (ctx) =>
      Effect.gen(function* () {
        const held = yield* ctx.integration.get({ integrationID: Integration.ID.make("anthropic") })
        const login = held.data.connections.filter((connection) => connection.type === "credential" && connection.id === LAW_LOGIN.id)
        yield* ensure(login.length === 1, `the integration lists ${held.data.connections.length} connections, the law login ${login.length} times`)
        const active = yield* ctx.integration.connection.active("anthropic")
        yield* ensure(active?.type === "credential" && active.id === LAW_LOGIN.id, "the active login is not the one held")
        const credential = Option.fromNullishOr(yield* ctx.integration.connection.resolve(login[0]))
        yield* ensure(
          Option.exists(credential, (value) => value.type === "oauth" && value.access === LAW_LOGIN.access),
          "resolve does not answer the login's credential",
        )
        yield* ctx.integration.connection.status({ integrationID: "anthropic", connection: login[0], status: { status: "needs_auth", message: "law: sign in again" } })
        const marked = (yield* ctx.integration.get({ integrationID: Integration.ID.make("anthropic") })).data.connections.filter(
          (connection) => connection.type === "credential" && connection.id === LAW_LOGIN.id,
        )
        yield* ensure(marked[0]?.type === "credential" && marked[0].status?.status === "needs_auth", "the login's mark is not on its connection")
        yield* ctx.integration.transform((draft) => {
          draft.method.update({
            integrationID: "anthropic",
            method: { id: "law-method", type: "oauth", label: "Law" },
            authorize: () => Effect.die(new LawBroken({ message: "the law's method was asked to authorize" })),
          })
        })
        const unknown = yield* Effect.exit(ctx.integration.get({ integrationID: Integration.ID.make("law-none") }))
        yield* ensure(unknown._tag === "Failure", "an integration the host lacks was found")
      }),
  },
  {
    name: LAW.provider,
    operations: ["provider.transform", "provider.list", "event.subscribe"],
    // Idle compaction looks at the catalog again on these events, its own location's alone.
    check: (ctx) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["provider.updated", "model.updated"] }).pipe(
            Stream.runForEach((event) =>
              Effect.when(
                Ref.update(seen, (all) => [...all, event.type]),
                Effect.succeed(event.location?.directory === ctx.location.directory),
              ),
            ),
          ),
          { startImmediately: true },
        )
        yield* ctx.provider.transform((editor) => {
          if (editor.get("openai")?.provider.activation === "auto")
            editor.update("openai", (provider) => {
              provider.activation = "enabled"
            })
        })
        const providers = yield* ctx.provider.list({ location: { directory: ctx.location.directory } })
        yield* ensure(
          providers.data.some((provider) => provider.id === "openai"),
          `the provider list after the transform is ${providers.data.map((provider) => provider.id).join(",")}`,
        )
        yield* settle
        const events = new Set(yield* Ref.get(seen))
        yield* ensure(events.has("provider.updated") && events.has("model.updated"), `the transform published ${[...events].join(",")} for this location`)
      }),
  },
  {
    name: LAW.toolHook,
    operations: ["tool.hook", "shell.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const repaired = yield* fresh(ctx)
        const refused = yield* fresh(ctx)
        const ours = new Set<string>([repaired.id, refused.id])
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const spawned = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.tool.hook("execute.before", (event) =>
          Effect.gen(function* () {
            if (!ours.has(event.sessionID)) return
            const command = Option.match(decodeCommand(event.input), { onNone: () => "an input not an object", onSome: (input) => input.command })
            yield* Ref.update(seen, (all) => [...all, `${event.tool} ${command}`])
            if (event.sessionID === refused.id) return yield* Effect.fail(new Tool.Error({ message: REFUSAL }))
          }),
        )
        yield* ctx.shell.hook("create.before", (invocation) => Effect.when(Ref.update(spawned, (all) => [...all, invocation.command]), Effect.succeed(invocation.command.includes("law-"))))
        yield* probe.turn(repaired.id, ctx.session.prompt({ sessionID: repaired.id, text: "law: call bash" }))
        yield* probe.turn(refused.id, ctx.session.prompt({ sessionID: refused.id, text: "law: call refused" }))
        const hooked = (yield* Ref.get(seen)).join(", ")
        yield* ensure(hooked === `shell echo ${REPAIRED}, shell echo ${REFUSED}`, `execute.before saw ${hooked}`)
        const ran = (yield* Ref.get(spawned)).join(", ")
        yield* ensure(ran === `echo ${REPAIRED}`, `the shell spawned ${ran}`)
        const first = yield* contextText(ctx, repaired.id)
        yield* ensure(count(first, "so this ran as") >= 1, "the repaired call's answer does not name the tool that ran")
        yield* ensure(count(first, "heard call bash") === 1, "the model did not answer once after the repaired call")
        const second = yield* contextText(ctx, refused.id)
        yield* ensure(count(second, REFUSAL) >= 1, "the model does not read the hook's refusal")
        yield* ensure(count(second, "heard call refused") === 1, "the model did not answer once after the refused call")
      }),
  },
  {
    name: LAW.shellHook,
    operations: ["shell.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const command = `echo ${SPAWNED}`
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.shell.hook("create.before", (invocation) =>
          Effect.sync(() => {
            if (invocation.command === command) invocation.shell = LAW_SHELL
          }),
        )
        yield* ctx.shell.hook("create.before", (invocation) =>
          Effect.when(
            Ref.update(seen, (all) => [...all, `${invocation.command} ${invocation.shell} ${invocation.cwd.endsWith(`/${LAW_FOLDER}`)}`]),
            Effect.succeed(invocation.command === command),
          ),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: call shell" }))
        const spawned = (yield* Ref.get(seen)).join(", ")
        yield* ensure(spawned === `${command} ${LAW_SHELL} true`, `the second create.before hook saw ${spawned}`)
        yield* ensure(count(yield* contextText(ctx, session.id), "heard call shell") === 1, "the model did not answer once after the shell call")
      }),
  },
  {
    name: LAW.agents,
    operations: ["agent.transform", "agent.list", "agent.get", "session.create"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const location = { directory: ctx.location.directory }
        yield* ctx.agent.transform((editor) =>
          editor.update(LAW_AGENT, (agent) => {
            agent.description = "law: the agent description"
            agent.system = "law: the agent system"
          }),
        )
        const listed = (yield* ctx.agent.list({ location })).data.filter((agent) => agent.id === LAW_AGENT)
        yield* ensure(listed.length === 1, `the agent list holds the defined agent ${listed.length} times`)
        const got = yield* ctx.agent.get({ agentID: Agent.ID.make(LAW_AGENT), location })
        yield* ensure(got.data.description === "law: the agent description", `get answered the description ${String(got.data.description)}`)
        yield* ensure(got.data.mode === "primary", `an agent made by an update is ${got.data.mode}, not primary`)
        const session = yield* ctx.session.create({ title: "law", agent: Agent.ID.make(LAW_AGENT) })
        yield* ensure((yield* ctx.session.get({ sessionID: session.id })).agent === LAW_AGENT, "the session does not run as the agent it was created on")
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: on the agent" }))
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "heard the agent system|on the agent") === 1, "the model did not read the agent's system prompt before the prompt")
      }),
  },
  {
    name: LAW.subagent,
    operations: ["session.prompt", "session.list", "session.get", "session.context"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        yield* ctx.agent.transform((editor) =>
          editor.update(LAW_CHILD, (agent) => {
            agent.mode = "subagent"
          }),
        )
        const parent = yield* fresh(ctx)
        const notices = yield* Ref.make(0)
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["session.inbox.enqueued"] }).pipe(
            Stream.runForEach((event) =>
              Effect.when(
                Ref.update(notices, (n) => n + 1),
                Effect.succeed(event.data.sessionID === parent.id && event.data.item.type === "synthetic" && event.data.item.payload.text.startsWith("<subagent ")),
              ),
            ),
          ),
          { startImmediately: true },
        )
        const call = callFor("subagent", { agent: LAW_CHILD, description: "law child", prompt: "law: the child task" })
        yield* probe.turn(parent.id, ctx.session.prompt({ sessionID: parent.id, text: call }))
        const children = (yield* ctx.session.list({ parentID: parent.id })).data
        yield* ensure(children.length === 1, `the call made ${children.length} children`)
        const child = children[0]!
        yield* ensure(child.agent === LAW_CHILD, `the child runs as ${child.agent}`)
        const answered = yield* contextText(ctx, parent.id)
        yield* ensure(count(answered, "is working in the background") === 1, "the call did not answer that the child runs in the background")
        // The child's idle reports to the parent, which wakes and reads it.
        const notice = `<subagent sessionID=\\"${child.id}\\"`
        for (let waited = 0; count(yield* contextText(ctx, parent.id), notice) === 0 && waited < 60_000; waited += 100) yield* Effect.sleep("100 millis")
        yield* settle
        const told = yield* contextText(ctx, child.id)
        yield* ensure(count(told, "You are a subagent spawned by another session.") === 1, "the child was not told it is a subagent")
        yield* ensure(count(told, "heard the child task") === 1, "the child did not answer its task")
        const after = yield* contextText(ctx, parent.id)
        yield* ensure((yield* Ref.get(notices)) === 1, `the parent got ${yield* Ref.get(notices)} subagent notices`)
        yield* ensure(count(after, notice) === 1, "the parent's context does not hold the child's notice")
        // The parent's answer to its call, the notice with the child's, and the parent's answer to the notice.
        yield* ensure(count(after, "heard the child task") >= 3, `the parent's context holds ${count(after, "heard the child task")} answers to the task, not its own, the child's and its own to the notice`)
      }),
  },
  {
    name: LAW.idleBackground,
    operations: ["session.hook", "session.prompt", "session.list"],
    // What a plugin reads to hold off while a session's subagent still works (the orchestrate plugin's idle root).
    check: (ctx, probe) =>
      Effect.gen(function* () {
        yield* ctx.agent.transform((editor) =>
          editor.update(LAW_CHILD, (agent) => {
            agent.mode = "subagent"
          }),
        )
        const parent = yield* fresh(ctx)
        const idles = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.session.hook("experimental.idle", (input) => {
          if (input.sessionID !== parent.id) return Effect.void
          const listed = input.background.map((item) => {
            if (item.kind === "subagent") return `subagent ${item.childSessionID}`
            return item.kind
          })
          return Ref.update(idles, (all) => [...all, listed.join(",")])
        })
        // The child works a few seconds in a foreground shell, past the parent's own turn.
        const call = callFor("subagent", { agent: LAW_CHILD, description: "law busy child", prompt: callFor("shell", { command: "sleep 3" }) })
        yield* probe.turn(parent.id, ctx.session.prompt({ sessionID: parent.id, text: call }))
        const children = (yield* ctx.session.list({ parentID: parent.id })).data
        yield* ensure(children.length === 1, `the call made ${children.length} children`)
        const child = children[0]!
        // The child's notice wakes the parent, whose turn on it ends in a second idle.
        for (let waited = 0; (yield* Ref.get(idles)).length < 2 && waited < 60_000; waited += 100) yield* Effect.sleep("100 millis")
        yield* settle
        const seen = yield* Ref.get(idles)
        yield* ensure(seen[0] === `subagent ${child.id}`, `the parent's first idle listed [${seen[0] ?? "no idle"}], not its running child`)
        yield* ensure(seen.length >= 2 && seen.at(-1) === "", `after the child's notice the parent's idles listed ${seen.map((line) => `[${line}]`).join(" ")}`)
      }),
  },
  {
    name: LAW.hooks,
    operations: ["tool.hook", "tool.transform"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const session = yield* fresh(ctx)
        const mine = (sessionID: string) => sessionID === session.id
        yield* ctx.tool.transform((editor) =>
          editor.add({
            name: "law_hooked",
            description: "echoes its text",
            // A direct tool, as the rift tool the orchestrate plugin hooks is.
            options: { codemode: false },
            input: Schema.Struct({ text: Schema.String }),
            execute: (input) => Effect.succeed({ content: `law: echoed ${input.text}` }),
          }),
        )
        yield* ctx.tool.hook("execute.before", (event) =>
          Effect.gen(function* () {
            if (!mine(event.sessionID) || event.tool !== "law_hooked") return
            const asked = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(event.input)
            yield* Ref.update(seen, (all) => [...all, `before ${Option.match(asked, { onNone: () => "?", onSome: (input) => input.text })}`])
            if (Option.exists(asked, (input) => input.text === "refuse")) return yield* new Tool.Error({ message: "law: refused by the hook" })
            event.input = { text: "changed" }
          }),
        )
        yield* ctx.tool.hook("execute.after", (event) =>
          Effect.gen(function* () {
            if (!mine(event.sessionID) || event.tool !== "law_hooked") return
            yield* Ref.update(seen, (all) => [...all, `after ${event.status}`])
            if (event.status === "completed") event.result = { ...event.result, content: "law: after the hook" }
          }),
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: callFor("law_hooked", { text: "asked" }) }))
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: callFor("law_hooked", { text: "refuse" }) }))
        const lines = (yield* Ref.get(seen)).join(",")
        yield* ensure(lines === "before asked,after completed,before refuse", `the tool hooks saw ${lines}`)
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "law: after the hook") >= 1, "the model did not read the result execute.after left")
        yield* ensure(count(text, "law: echoed") === 0, "the model read the result execute.after replaced")
        yield* ensure(count(text, "law: refused by the hook") >= 1, "the model did not read the refusal's message")
      }),
  },
  {
    name: LAW.update,
    operations: ["tool.transform"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const wrapped = yield* Ref.make(0)
        yield* ctx.agent.transform((editor) =>
          editor.update(LAW_CHILD, (agent) => {
            agent.mode = "subagent"
          }),
        )
        yield* ctx.tool.transform((editor) =>
          editor.update("subagent", (tool) => {
            const execute = tool.execute
            tool.execute = (input, context) =>
              Ref.update(wrapped, (n) => n + 1).pipe(
                Effect.andThen(execute(input, context)),
                Effect.map((result) => ({ ...result, content: `law: through the wrapper\n${resultContent(result.content)}` })),
              )
          }),
        )
        const session = yield* fresh(ctx)
        const call = callFor("subagent", { agent: LAW_CHILD, description: "law wrapped", prompt: "law: the wrapped task" })
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: call }))
        yield* ensure((yield* Ref.get(wrapped)) === 1, `the wrapper ran ${yield* Ref.get(wrapped)} times`)
        yield* ensure(count(yield* contextText(ctx, session.id), "law: through the wrapper") >= 1, "the model did not read the wrapper's answer")
      }),
  },
  {
    name: LAW.shell,
    operations: ["shell.hook"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        yield* ctx.shell.hook("create.before", (event) =>
          Effect.gen(function* () {
            if (!event.command.includes("law-shell")) return
            yield* Ref.update(seen, (all) => [...all, event.command])
            event.env.LAW_SHELL = "set"
          }),
        )
        const session = yield* fresh(ctx)
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: callFor("shell", { command: "echo law-shell" }) }))
        const commands = (yield* Ref.get(seen)).join(",")
        yield* ensure(commands === "echo law-shell", `the create.before hook saw ${commands}`)
      }),
  },
  {
    name: LAW.compaction,
    operations: ["session.hook", "session.compact"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        yield* ctx.session.hook("compaction", (event) =>
          Effect.sync(() => {
            if (event.sessionID === session.id) event.messages.push({ role: "user", content: [{ type: "text", text: "law: kept for the summary" }] })
          }),
        )
        const seen = yield* Ref.make<ReadonlyArray<{ readonly id: string; readonly type: string; readonly text: string }>>([])
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["session.compaction.started", "session.compaction.ended"] }).pipe(
            Stream.runForEach((event) =>
              Effect.when(
                Ref.update(seen, (all) => [...all, { id: event.id, type: event.type, text: Option.getOrElse(Option.map(Schema.decodeUnknownOption(Summary)(event.data), (data) => data.text), () => "") }]),
                Effect.succeed(event.data.sessionID === session.id),
              ),
            ),
          ),
          { startImmediately: true },
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: before the hooked compaction" }))
        yield* probe.turn(session.id, ctx.session.compact({ sessionID: session.id }))
        yield* ensure(count(yield* contextText(ctx, session.id), KEPT_IN_SUMMARY) === 1, "the compaction request did not carry the hook's message")
        // The compaction's start and end are one event each, each with an id of its own; the end carries the summary.
        const events = yield* Ref.get(seen)
        const types = events.map((event) => event.type).join(",")
        yield* ensure(types === "session.compaction.started,session.compaction.ended", `the compaction published ${types}`)
        yield* ensure(events[0]?.id !== events[1]?.id && events.every((event) => event.id !== ""), `the compaction events' ids were ${events.map((event) => event.id).join(",")}`)
        yield* ensure(events[1]?.text.includes(KEPT_IN_SUMMARY) === true, "the compaction's ended event does not carry its summary")
      }),
  },
  {
    name: LAW.move,
    operations: ["session.move", "session.get", "session.prompt", "session.context", "event.subscribe"],
    // The test host makes the folder beside the law folder (tests/host-laws/real.ts); the world keeps no folders.
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const home = ctx.location.directory
        const away = AbsolutePath.make(`${home}${LAW_MOVED}`)
        const moves = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.forkScoped(
          ctx.event.subscribe({ types: ["session.moved"] }).pipe(
            Stream.runForEach((event) =>
              Effect.when(Ref.update(moves, (all) => [...all, event.data.location.directory]), Effect.succeed(event.data.sessionID === session.id)),
            ),
          ),
          { startImmediately: true },
        )
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: before the move" }))
        const ownRequests = probe.requests.pipe(Effect.map((all) => all.filter((request) => request.sessionID === session.id).length))
        /** Moves the idle session to `directory`, and waits until it is there. */
        const moveTo = (directory: AbsolutePath) =>
          Effect.gen(function* () {
            yield* ctx.session.move({ sessionID: session.id, directory })
            for (let waited = 0; (yield* ctx.session.get({ sessionID: session.id })).location.directory !== directory; waited += 100) {
              if (waited > 10_000) return yield* Effect.fail(new LawBroken({ message: `the session is not in ${directory} 10 s after the move` }))
              yield* Effect.sleep("100 millis")
            }
          })
        /** Prompts the session, and waits until the model's answer is in its context: the prompt and the answer both name `heard`. */
        const answered = (text: string, heard: string) =>
          Effect.gen(function* () {
            yield* ctx.session.prompt({ sessionID: session.id, text })
            for (let waited = 0; count(yield* contextText(ctx, session.id), heard) < 2; waited += 100) {
              if (waited > 60_000) return yield* Effect.fail(new LawBroken({ message: `the moved session did not answer "${text}" within 60 s` }))
              yield* Effect.sleep("100 millis")
            }
            yield* settle
          })
        const before = yield* ownRequests
        yield* moveTo(away)
        yield* settle
        yield* ensure((yield* ownRequests) === before, "the move of an idle session asked the model")
        // Moved, its turn is the new location's: this copy's model.request hook does not see it.
        yield* answered("law: after the move", "after the move")
        yield* ensure((yield* ownRequests) === before, "this location's model.request hook ran for a session moved away")
        yield* moveTo(home)
        yield* answered("law: back home", "back home")
        yield* ensure((yield* ownRequests) > before, "this location's model.request hook did not run for a session moved back")
        const seen = (yield* Ref.get(moves)).join(",")
        yield* ensure(seen === `${away},${home}`, `the session.moved events were ${seen}`)
      }),
  },
  {
    name: LAW.window,
    operations: ["agent.transform", "session.create"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        yield* ctx.agent.transform((editor) =>
          editor.update(LAW_WINDOW, (agent) => {
            agent.request.settings.compactionWindow = WINDOW_TOKENS
          }),
        )
        const compacted = (sessionID: SessionID) =>
          ctx.session.context({ sessionID }).pipe(
            Effect.map((messages) => messages.filter((message) => Schema.is(Schema.Struct({ type: Schema.Literal("compaction"), reason: Schema.Literal("auto") }))(message)).length),
          )
        const windowed = yield* ctx.session.create({ title: "law", agent: Agent.ID.make(LAW_WINDOW) })
        const plain = yield* fresh(ctx)
        for (const session of [windowed, plain]) {
          yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: the first turn" }))
          yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: the second turn" }))
        }
        yield* ensure((yield* compacted(windowed.id)) >= 1, "the session on the windowed agent was not compacted automatically")
        yield* ensure((yield* compacted(plain.id)) === 0, "a session without the window was compacted")
      }),
  },
  {
    name: LAW.options,
    operations: ["options", "location"],
    check: (ctx) =>
      Effect.gen(function* () {
        yield* ensure(
          Schema.is(Schema.Struct({ law: Schema.Literal("probe"), depth: Schema.Literal(2) }))(ctx.options),
          "the options are not the configured ones",
        )
        yield* ensure(ctx.location.directory.endsWith(`/${LAW_FOLDER}`), `the location was ${ctx.location.directory}`)
      }),
  },
  {
    name: LAW.report,
    operations: ["session.create", "session.prompt", "session.context"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const parent = yield* fresh(ctx)
        const child = yield* ctx.session.create({ parentID: parent.id, title: "law child" })
        // The child's turn ends with an answer; its report wakes the parent into a turn of its own.
        yield* probe.turn(parent.id, probe.turn(child.id, ctx.session.prompt({ sessionID: child.id, text: "law: child report" })))
        const messages = yield* ctx.session.context({ sessionID: parent.id })
        const reports = messages.flatMap((message) => Arr.fromOption(Schema.decodeUnknownOption(Report)(message)))
        yield* ensure(reports.length === 1, `the parent holds ${reports.length} subagent reports`)
        const [report] = reports
        yield* ensure(report?.metadata.childID === child.id, `the report names ${report?.metadata.childID ?? "no child"}, not the child`)
        yield* ensure(report?.description === "law child", `the report's description is ${report?.description ?? "none"}`)
        yield* ensure(Option.exists(Option.fromNullishOr(report), (found) => found.text.includes("heard child report")), "the report does not carry the child's answer")
        const primary = (yield* probe.requests).filter((request) => request.sessionID === parent.id && request.kind === "primary")
        yield* ensure(primary.length === 1, `the report brought the parent ${primary.length} requests`)
        const text = yield* contextText(ctx, parent.id)
        yield* ensure(text.indexOf("heard child report") < text.lastIndexOf("heard"), "the parent's turn did not follow the report")
      }),
  },
  {
    name: LAW.located,
    operations: ["event.subscribe", "session.create", "session.prompt"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlySet<string>>(new Set())
        yield* Effect.forkScoped(
          ctx.event
            .subscribe({ types: ["session.inbox.enqueued", "session.execution.started", "session.execution.succeeded"] })
            .pipe(Stream.runForEach((event) => Ref.update(seen, (all) => new Set([...all, String(event.data.sessionID)])))),
          { startImmediately: true },
        )
        const directory = `${ctx.location.directory.slice(0, -LAW_FOLDER.length)}${ELSEWHERE_FOLDER}`
        const elsewhere = yield* ctx.session.create({ location: { directory: AbsolutePath.make(directory) }, title: "law elsewhere" })
        yield* ctx.session.prompt({ sessionID: elsewhere.id, text: "law: elsewhere" })
        // Its events are not this copy's to hear: wait for its answer through the context instead.
        for (let waited = 0; count(yield* contextText(ctx, elsewhere.id), "heard elsewhere") === 0; waited += 100) {
          if (waited > 60_000) return yield* Effect.fail(new LawBroken({ message: "the session elsewhere was not answered within 60 s" }))
          yield* Effect.sleep("100 millis")
        }
        const here = yield* fresh(ctx)
        yield* probe.turn(here.id, ctx.session.prompt({ sessionID: here.id, text: "law: here" }))
        const heard = yield* Ref.get(seen)
        yield* ensure(heard.has(here.id), "the plugin did not hear its own location's session")
        yield* ensure(!heard.has(elsewhere.id), "the plugin heard a session in another location")
      }),
  },
  {
    // Memory's digest rides on it: the part the hooks add is in every request of the session that sends the conversation.
    name: LAW.system,
    operations: ["session.hook", "session.get", "session.compact"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        // No title given, so the host asks the model for one: the title request runs neither hook.
        const session = yield* ctx.session.create({})
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        /** The system prompt each primary request's context hook was given, before it added its part. */
        const prompts = yield* Ref.make<ReadonlyArray<string>>([])
        const hooked = (name: "context" | "compaction") => (event: { readonly sessionID: string; system: Array<{ type: "text"; text: string }> }) =>
          Effect.gen(function* () {
            if (event.sessionID !== session.id) return
            const instructed = event.system.some((part) => part.text.trim() !== "")
            yield* Ref.update(seen, (all) => [...all, `${name} ${String(instructed)}`])
            if (name === "context") yield* Ref.update(prompts, (all) => [...all, event.system.map((part) => part.text).join("\n")])
            event.system.push({ type: "text", text: `law: ${name} part` })
          })
        yield* ctx.session.hook("context", hooked("context"))
        yield* ctx.session.hook("compaction", hooked("compaction"))
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: system" }))
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "heard context part|system") === 1, "the model did not read the part the context hook added before the prompt")
        // A second turn: the host gives the hook the same system prompt, so a part added last keeps the cached prefix.
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: system again" }))
        const given = yield* Ref.get(prompts)
        yield* ensure(given.length === 2 && given[0] === given[1], `the context hook was given ${given.length} system prompts, ${new Set(given).size} distinct`)
        yield* probe.turn(session.id, ctx.session.compact({ sessionID: session.id, reason: "auto" }))
        const kinds = (kind: string) => probe.requests.pipe(Effect.map((all) => all.filter((request) => request.sessionID === session.id && request.kind === kind).length))
        for (let waited = 0; (yield* kinds("title")) === 0; waited += 100) {
          if (waited > 60_000) return yield* Effect.fail(new LawBroken({ message: "the host asked for no title within 60 s" }))
          yield* Effect.sleep("100 millis")
        }
        yield* settle
        const lines = yield* Ref.get(seen)
        const ran = (name: string) => lines.filter((entry) => entry === `${name} true`).length
        yield* ensure(lines.every((entry) => entry.endsWith(" true")), `a hook saw a system prompt without the host's instructions: ${lines.join(", ")}`)
        const primary = yield* kinds("primary")
        yield* ensure(ran("context") === primary && primary === 2, `the context hook ran ${ran("context")} times for ${primary} primary requests`)
        const compactions = yield* kinds("compaction")
        yield* ensure(ran("compaction") === compactions && compactions === 1, `the compaction hook ran ${ran("compaction")} times for ${compactions} compaction requests`)
        const first = yield* ctx.session.get({ sessionID: session.id })
        const other = yield* ctx.session.get({ sessionID: (yield* fresh(ctx)).id })
        // Which project is the host's (a repository's id, or `global` outside one): the real run's law folder sits in a
        // repository, so only the sharing is a law.
        yield* ensure(first.projectID !== "" && first.projectID === other.projectID, `two sessions of one location are in projects ${first.projectID} and ${other.projectID}`)
      }),
  },
  {
    // What mail reads of a session and the inbox it writes to (mods/mail/opencode/sessions.ts).
    name: LAW.mail,
    operations: ["session.get", "session.synthetic", "session.hook", "session.prompt"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const nowhere = SessionID.make("ses_lawnowhere000001")
        const missing = yield* Effect.flip(ctx.session.get({ sessionID: nowhere }))
        yield* ensure(Schema.is(Schema.Struct({ _tag: Schema.Literal("Session.NotFoundError") }))(missing), "get of an unknown id did not fail as not found")
        const refused = yield* Effect.flip(ctx.session.synthetic({ sessionID: nowhere, text: "law: nowhere", description: "law", resume: true }))
        yield* ensure(Schema.is(Schema.Struct({ _tag: Schema.Literal("Session.NotFoundError") }))(refused), "a synthetic message to an unknown id did not fail as not found")

        const session = yield* fresh(ctx)
        const runs = (info: SessionInfo) =>
          Option.match(Option.map(Option.fromNullishOr(info.time.busy), DateTime.toEpochMillis), {
            onNone: () => false,
            onSome: (busy) =>
              Option.match(Option.map(Option.fromNullishOr(info.time.idle), DateTime.toEpochMillis), { onNone: () => true, onSome: (idle) => busy > idle }),
          })
        const seen = yield* Ref.make<ReadonlyArray<boolean>>([])
        const steered = yield* Ref.make(false)
        yield* ctx.session.hook("model.request", (input) =>
          Effect.gen(function* () {
            if (input.sessionID !== session.id || input.kind !== "primary") return
            const info = yield* ctx.session.get({ sessionID: session.id })
            yield* Ref.update(seen, (all) => [...all, runs(info)])
            if (yield* Ref.getAndSet(steered, true)) return
            yield* ctx.session.synthetic({ sessionID: session.id, text: "law: steered while running", description: "law", resume: true })
          }).pipe(Effect.orDie),
        )
        yield* Effect.sleep(STEP)
        yield* probe.turn(session.id, ctx.session.prompt({ sessionID: session.id, text: "law: running" }))
        const during = yield* Ref.get(seen)
        yield* ensure(during.length >= 2 && during.every((running) => running), `while it ran, get answered running ${during.join(",")}`)
        const rested = yield* ctx.session.get({ sessionID: session.id })
        yield* ensure(!runs(rested), "get answered running once the session rested")
        const updated = DateTime.toEpochMillis(rested.time.updated)
        yield* ensure(updated > DateTime.toEpochMillis(session.time.updated), "the session's last update did not move with its turn")
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "law: steered while running") === 1, `the session holds the steer ${count(text, "law: steered while running")} times`)
        yield* ensure(count(text, "heard running|steered while running") === 1, "no request after the steer carried it")

        // A parcel that arrives twice comes under one id (mods/mail/model.ts receive): the first admission wins.
        const once = { id: SessionMessage.ID.make(`msg_mail_law_${session.id}`), sessionID: session.id, text: "law: a parcel twice", description: "law", resume: true }
        yield* probe.turn(session.id, ctx.session.synthetic(once))
        yield* ctx.session.synthetic(once)
        yield* settle
        const held = count(yield* contextText(ctx, session.id), "law: a parcel twice")
        yield* ensure(held === 1, `a synthetic admitted twice under one id is held ${held} times`)
      }),
  },
]

/** A subagent's report in its parent, as `session.context` lists it, as much as the law reads. */
const Report = Schema.Struct({
  type: Schema.Literal("synthetic"),
  text: Schema.String,
  description: Schema.String,
  metadata: Schema.Struct({ source: Schema.Literal("subagent"), childID: Schema.String }),
})

// The host laws: what OpenCode does for a plugin, each law over the plugin
// context's own operations, written once against the fork's `Plugin.Context`
// and run on both hosts by the law probe (sim/server.ts), a plugin that runs
// every law from inside the host. sim/host-laws.test.ts loads it into the
// world; tests/host-laws.test.ts into real OpenCode (sim/real.ts), on a
// scripted model that answers as `answer` says.
//
// Every operation the world's context offers (context.ts OPERATIONS) is named
// by at least one law (sim/host-laws.test.ts holds that), so no world
// behaviour a plugin can reach stands without a law real OpenCode also passes.
//
// A law reads the host only through the context: what it answers, the events
// it publishes and the hooks it runs. The probe (`probeOf`) is made of the
// same: it counts each session's executions from the host's events and the
// model's requests from the `model.request` hook.
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Provider } from "@opencode/schema/provider"
import type { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Data, Effect, Option, Ref, Schema, type Scope, Stream } from "effect"
import type { OPERATIONS } from "./context.ts"
import { LAW } from "./law-names.ts"

export type Operation = (typeof OPERATIONS)[number]

/** A law broken: what was expected and what the host did. */
export class LawBroken extends Data.TaggedError("LawBroken")<{ readonly message: string }> {}

/** The model's answer to a law's request: by its kind, and a turn names every law marker its request carried. */
export const answer = (kind: "primary" | "compaction" | "title", text: string) => {
  if (kind === "title") return "Law title"
  if (kind === "compaction") return SUMMARY
  return `heard ${[...text.matchAll(/law: ([a-z ]+[a-z])/g)].map((match) => match[1]).join("|")}`
}

/** The model's summary when the host compacts. */
export const SUMMARY = "## Objective\n- law: the session's summary"

/** The law probe's options, as both hosts configure it. */
export const PROBE_OPTIONS = { law: "probe", depth: 2 }

/** The folder the law probe's copy runs the laws in: a host may load it for other folders too. */
export const LAW_FOLDER = "law"

/** What a law reads beside the context's answers: the model's requests and when a session is at rest. */
export interface Probe {
  /** The model's requests so far, as the `model.request` hook saw them. */
  readonly requests: Effect.Effect<ReadonlyArray<{ readonly sessionID: string; readonly kind: string }>>
  /** Runs `action`, then waits until the session ran an execution after it and has none running. */
  readonly turn: <A, E>(sessionID: string, action: Effect.Effect<A, E>) => Effect.Effect<A, E | LawBroken>
}

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
    const probe: Probe = { requests: Ref.get(requests), turn }
    return probe
  })

const fresh = (ctx: Plugin.Context) => ctx.session.create({ title: "law" })

/** What a session's context holds, as one JSON text, for a law to look into. */
const contextText = (ctx: Plugin.Context, sessionID: SessionID) =>
  ctx.session.context({ sessionID }).pipe(Effect.flatMap((messages) => Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(messages)))

const count = (text: string, part: string) => text.split(part).length - 1

/** A short wait on the host's clock: long enough for work that would start to start. */
const settle = Effect.sleep("2 seconds")

/** A session list's "no parent", as the fork's API takes it and idle compaction asks for its roots (JSON null). */
const ROOT = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")

/** The law's RPC: one method that answers its input. */
const LAW_RPC = {
  id: "dotfiles-opencode.sim-law",
  methods: { echo: { input: { type: "object" }, output: { type: "object" } } },
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
        const info = yield* ctx.session.get({ sessionID: session.id })
        yield* ensure(info.id === session.id, "get answered another session")
      }),
  },
  {
    name: LAW.steer,
    operations: ["session.synthetic", "session.context"],
    check: (ctx, probe) =>
      Effect.gen(function* () {
        const session = yield* fresh(ctx)
        const steer = { sessionID: session.id, id: SessionMessage.ID.make("msg_lawsteeronce0001"), text: "law: steer once", description: "law", resume: true }
        yield* probe.turn(session.id, ctx.session.synthetic(steer))
        yield* ctx.session.synthetic(steer).pipe(Effect.ignore)
        yield* settle
        const text = yield* contextText(ctx, session.id)
        yield* ensure(count(text, "heard steer once") === 1, `the model answered the steer ${count(text, "heard steer once")} times`)
        yield* ensure(count(text, "law: steer once") === 1, `the session holds the steer ${count(text, "law: steer once")} times`)
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
    name: LAW.sessions,
    operations: ["session.create", "session.list", "session.get", "session.update"],
    check: (ctx) =>
      Effect.gen(function* () {
        const parent = yield* fresh(ctx)
        const child = yield* ctx.session.create({ parentID: parent.id, title: "law child" })
        const children = yield* ctx.session.list({ parentID: parent.id })
        yield* ensure(children.data.map((session) => session.id).join(",") === child.id, "the parent's children are not its one child")
        const roots = yield* ctx.session.list({ parentID: ROOT, directory: ctx.location.directory })
        yield* ensure(
          roots.data.some((session) => session.id === parent.id),
          "the roots miss the parent",
        )
        yield* ensure(!roots.data.some((session) => session.id === child.id), "the roots list a child")
        yield* ctx.session.update({ sessionID: child.id, metadata: { law: "kept" } })
        const info = yield* ctx.session.get({ sessionID: child.id })
        yield* ensure(Schema.is(Schema.Struct({ law: Schema.Literal("kept") }))(info.metadata), "get does not answer the updated metadata")
      }),
  },
  {
    name: LAW.catalog,
    operations: ["model.list", "provider.list", "provider.get", "agent.list", "agent.get"],
    check: (ctx) =>
      Effect.gen(function* () {
        const location = { directory: ctx.location.directory }
        const models = yield* ctx.model.list({ location })
        yield* ensure(
          models.data.some((model) => model.providerID === "sim" && model.id === "sim-model"),
          "the model list lacks sim/sim-model",
        )
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
]

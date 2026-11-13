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
import { Integration, type Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Data, Effect, Option, Ref, Schema, type Scope, Stream } from "effect"
import type { OPERATIONS } from "./context.ts"
import { LAW, LAW_FOLDER, LAW_LOGIN, RATE_LIMITED, UNAUTHORIZED, USAGE_LIMITED } from "./law-names.ts"

export type Operation = (typeof OPERATIONS)[number]

/** A law broken: what was expected and what the host did. */
export class LawBroken extends Data.TaggedError("LawBroken")<{ readonly message: string }> {}

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
    operations: ["provider.transform", "provider.list"],
    check: (ctx) =>
      Effect.gen(function* () {
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
]

// The client laws: what the server double (server.ts) does for the TUI, each
// stated as a law a server must keep, run on the double (client-laws.test.ts)
// and on real OpenCode (tests/client-laws.test.ts) through one `LawServer`
// shape. Every route the double serves (`SERVED`) and every event kind it may
// send (`EVENTS`) is named by a law (`ROUTES`, `KINDS`); client-laws.test.ts
// fails on one no law names.
//
// A law runs on a fresh root session, through HTTP-shaped calls and the events
// the server sent since the law began. Its scripted model answers as the real
// scenarios' does: a prompt containing `stall` streams `Working on it` and
// holds; `spawn` starts one background worker; anything else answers `Done.`.
import { Array as Arr, Data, Effect, Option, Schema } from "effect"
import type { EventKind, ModelRef, SERVED } from "./server.ts"

export type Route = (typeof SERVED)[number]

/** One call's answer: its status and its JSON body (none for 204). */
export interface Answer {
  readonly status: number
  readonly body: Option.Option<unknown>
}

/** An event the server sent: its kind and its data. */
export interface Sent {
  readonly type: string
  readonly data: unknown
}

/** A JSON body a law sends. */
export interface Payload {
  readonly [key: string]: string | number | boolean | Payload | ReadonlyArray<string | Payload>
}

/** A call a law makes: its method, its path and its JSON body, if it has one. */
export interface Call {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE"
  readonly path: string
  readonly body: Option.Option<Payload>
}

/** A server could not be reached, or answered what no law can read. */
export class LawServerError extends Data.TaggedError("LawServerError")<{ readonly message: string; readonly cause?: unknown }> {}

/** A server under the laws: the double, or real OpenCode. */
export interface LawServer {
  /** A root session, idle and empty. */
  readonly session: Effect.Effect<string, LawServerError>
  readonly call: (call: Call) => Effect.Effect<Answer, LawServerError>
  /** Every event sent since the server started, in order. */
  readonly sent: Effect.Effect<ReadonlyArray<Sent>>
  /** Lets the server finish what it does (the double's queued events; the real server's run). */
  readonly settle: Effect.Effect<void>
  /** The model a new session runs on. */
  readonly model: ModelRef
}

export interface Law {
  readonly name: string
  readonly routes: ReadonlyArray<Route>
  readonly kinds: ReadonlyArray<EventKind>
  /** The law's failures on `server`, empty when it holds. */
  readonly run: (server: LawServer) => Effect.Effect<ReadonlyArray<string>, LawServerError>
}

const get = (path: string): Call => ({ method: "GET", path, body: Option.none() })
const post = (path: string, body: Payload = {}): Call => ({ method: "POST", path, body: Option.some(body) })

const prompt = (server: LawServer, sessionID: string, text: string, delivery: "steer" | "queue" = "steer") =>
  server.call(post(`/api/session/${sessionID}/prompt`, { text, files: [], agents: [], delivery }))

const EventData = Schema.Struct({ sessionID: Schema.optional(Schema.String), parentID: Schema.optional(Schema.String) })
/** What an event's data says about its session, as far as a law reads it. */
const dataOf = (event: Sent) => Option.getOrElse(Schema.decodeUnknownOption(EventData)(event.data), () => ({ sessionID: "", parentID: "" }))

/** The kinds of the events about `sessionID` sent after the first `from`. */
const kindsOf = (server: LawServer, sessionID: string, from = 0) =>
  Effect.map(server.sent, (sent) =>
    sent
      .slice(from)
      .filter((event) => dataOf(event).sessionID === sessionID)
      .map((event) => event.type),
  )

/** Each of `want` not found in `kinds` in that order, as a failure. */
const inOrder = (kinds: ReadonlyArray<string>, want: ReadonlyArray<string>) => {
  const state = { at: 0 }
  return want.flatMap((kind) => {
    const found = kinds.indexOf(kind, state.at)
    if (found < 0) return [`no ${kind} after ${kinds.slice(0, state.at).at(-1) ?? "the start"} (sent: ${kinds.join(", ")})`]
    state.at = found + 1
    return []
  })
}

const expectStatus = (what: string, answer: Answer, status: number) => {
  if (answer.status === status) return []
  return [`${what}: status ${answer.status}, not ${status} (${shown(answer)})`]
}

const Json = Schema.fromJsonString(Schema.Unknown)
/** An answer's body read as `schema`; none when it is not one. */
const read = <S extends Schema.Decoder<unknown>>(schema: S, answer: Answer) => Option.flatMap(answer.body, Schema.decodeUnknownOption(schema))
const shown = (answer: Answer) => Schema.encodeSync(Json)(Option.getOrElse(answer.body, () => ""))

const MessageList = Schema.Struct({ data: Schema.Array(Schema.Struct({ type: Schema.String, id: Schema.String })) })
const Active = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const Interrupted = Schema.Struct({ interrupted: Schema.Literal(true) })
const Item = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
const Inbox = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String, delivery: Schema.String })) })
const Idle = Schema.Struct({ data: Schema.Struct({ time: Schema.Struct({ idle: Schema.optional(Schema.Number) }) }) })
const Ended = Schema.Struct({ data: Schema.Struct({ outcome: Schema.optional(Schema.String) }) })
const Unavailable = Schema.Struct({ _tag: Schema.Literal("RpcError"), type: Schema.Literal("rpc.unavailable") })
const Goal = Schema.Struct({ output: Schema.Null })

/** The ids of the session's messages of `type`. */
const messagesOf = (server: LawServer, sessionID: string, type: string) =>
  Effect.map(server.call(get(`/api/session/${sessionID}/message`)), (answer) =>
    Option.match(read(MessageList, answer), {
      onNone: () => [],
      onSome: (list) => list.data.filter((message) => message.type === type).map((message) => message.id),
    }),
  )

/** A session with a run that stalls, and a second prompt queued behind it: the session and the queued item. */
const queuedBehindStall = (server: LawServer) =>
  Effect.gen(function* () {
    const sessionID = yield* server.session
    yield* prompt(server, sessionID, "stall here")
    yield* server.settle
    const queued = yield* prompt(server, sessionID, "Also update the docs.", "queue")
    yield* server.settle
    return { sessionID, queued, item: Option.match(read(Item, queued), { onNone: () => "", onSome: (found) => found.data.id }) }
  })

export const LAWS: ReadonlyArray<Law> = [
  {
    name: "a prompt to an idle session runs: it is enqueued, the run starts and takes it, a step streams its text and ends, the run succeeds, and the transcript holds both messages",
    routes: ["session.prompt", "session.messages", "session.message", "session.get", "session.list", "session.active", "session.wait"],
    kinds: [
      "session.inbox.enqueued",
      "session.inbox.delivered",
      "session.execution.started",
      "session.step.started",
      "session.step.first-token",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.execution.succeeded",
      "session.renamed",
    ],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        const sent = yield* prompt(server, sessionID, "Answer briefly.")
        yield* server.settle
        const failures = [
          ...expectStatus("prompt", sent, 200),
          ...inOrder(yield* kindsOf(server, sessionID), [
            "session.inbox.enqueued",
            "session.execution.started",
            "session.inbox.delivered",
            "session.step.started",
            "session.text.delta",
            "session.text.ended",
            "session.step.ended",
            "session.execution.succeeded",
          ]),
        ]
        const messages = yield* server.call(get(`/api/session/${sessionID}/message`))
        const types = Option.match(read(MessageList, messages), { onNone: () => [], onSome: (list) => list.data.map((message) => message.type) })
        // The real transcript holds more kinds (its idle marker); the law reads the two the TUI draws.
        if (types.filter((type) => type === "user" || type === "assistant").toSorted().join(",") !== "assistant,user") failures.push(`messages: ${shown(messages)}`)
        for (const id of yield* messagesOf(server, sessionID, "assistant"))
          failures.push(...expectStatus("message", yield* server.call(get(`/api/session/${sessionID}/message/${id}`)), 200))
        const info = yield* server.call(get(`/api/session/${sessionID}`))
        failures.push(...expectStatus("get", info, 200))
        // The session says how its last run ended (a subagent's dock row reads it).
        if (!Option.exists(read(Ended, info), (found) => found.data.outcome === "succeeded")) failures.push(`outcome: ${shown(info)}`)
        failures.push(...expectStatus("list", yield* server.call(get("/api/session")), 200))
        const active = yield* server.call(get("/api/session/active"))
        if (Option.exists(read(Active, active), (found) => sessionID in found.data)) failures.push("active: the idle session is listed")
        failures.push(...expectStatus("wait on an idle session", yield* server.call(post(`/api/experimental/session/${sessionID}/wait`)), 204))
        return failures
      }),
  },
  {
    name: "an interrupt ends a running step: the step fails aborted, the run is interrupted, and the answer says it interrupted",
    routes: ["session.interrupt"],
    kinds: ["session.step.failed", "session.execution.interrupted", "session.tool.failed", "session.reasoning.started", "session.reasoning.delta"],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        yield* prompt(server, sessionID, "stall here")
        yield* server.settle
        const from = (yield* server.sent).length
        const answer = yield* server.call(post(`/api/session/${sessionID}/interrupt`))
        yield* server.settle
        const failures = [...expectStatus("interrupt", answer, 200)]
        if (Option.isNone(read(Interrupted, answer))) failures.push(`interrupt answered ${shown(answer)}`)
        failures.push(...inOrder(yield* kindsOf(server, sessionID, from), ["session.step.failed", "session.execution.interrupted"]))
        return failures
      }),
  },
  {
    name: "a prompt sent while a run works waits in the inbox; taking it back cancels it and says so",
    routes: ["session.inbox.list", "session.inbox.cancel"],
    kinds: ["session.inbox.cancelled"],
    run: (server) =>
      Effect.gen(function* () {
        const { sessionID, item } = yield* queuedBehindStall(server)
        const listed = yield* server.call(get(`/api/session/${sessionID}/inbox`))
        const failures = [...expectStatus("inbox", listed, 200)]
        if (!Option.exists(read(Inbox, listed), (inbox) => inbox.data.some((each) => each.id === item))) failures.push(`inbox: ${shown(listed)}`)
        failures.push(...expectStatus("cancel", yield* server.call({ method: "DELETE", path: `/api/session/${sessionID}/inbox/${item}`, body: Option.none() }), 204))
        yield* server.settle
        failures.push(...inOrder(yield* kindsOf(server, sessionID), ["session.inbox.enqueued", "session.inbox.cancelled"]))
        return failures
      }),
  },
  {
    name: "a queued prompt switched to steer says so and is delivered; switching an item the inbox does not hold fails 409",
    routes: ["session.inbox.update"],
    kinds: ["session.inbox.delivery.changed"],
    run: (server) =>
      Effect.gen(function* () {
        const { sessionID, item } = yield* queuedBehindStall(server)
        const path = `/api/session/${sessionID}/inbox/${item}`
        const from = (yield* server.sent).length
        const failures = [...expectStatus("steer", yield* server.call({ method: "PATCH", path, body: Option.some({ delivery: "steer" }) }), 204)]
        yield* server.settle
        failures.push(...inOrder(yield* kindsOf(server, sessionID, from), ["session.inbox.delivery.changed"]))
        const missing = yield* server.call({ method: "PATCH", path: `/api/session/${sessionID}/inbox/msg_missing`, body: Option.some({ delivery: "steer" }) })
        failures.push(...expectStatus("an item the inbox does not hold", missing, 409))
        return failures
      }),
  },
  {
    name: "an undo stages a revert and says so; committing it says so",
    routes: ["session.revert.stage", "session.revert.commit"],
    kinds: ["session.revert.staged", "session.revert.committed"],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        yield* prompt(server, sessionID, "Answer briefly.")
        yield* server.settle
        const user = Arr.head(yield* messagesOf(server, sessionID, "user"))
        const failures = [
          ...expectStatus("stage", yield* server.call(post(`/api/session/${sessionID}/revert/stage`, { messageID: Option.getOrElse(user, () => "") })), 200),
          ...expectStatus("commit", yield* server.call(post(`/api/session/${sessionID}/revert/commit`)), 204),
        ]
        yield* server.settle
        failures.push(...inOrder(yield* kindsOf(server, sessionID), ["session.revert.staged", "session.revert.committed"]))
        return failures
      }),
  },
  {
    name: "a session made with no agent or model of its own says so at every agent switch and at its first model switch; then a switch to the model it has says nothing",
    routes: ["session.switchAgent", "session.switchModel"],
    kinds: ["session.agent.selected", "session.model.selected"],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        yield* server.settle
        const agent = post(`/api/session/${sessionID}/agent`, { agent: "plan" })
        const model = post(`/api/session/${sessionID}/model`, { model: server.model })
        const from = (yield* server.sent).length
        // A new session has no agent or model of its own: the first switch to either sets it, and says so.
        const failures = [...expectStatus("other agent", yield* server.call(agent), 204), ...expectStatus("a model", yield* server.call(model), 204)]
        yield* server.settle
        failures.push(...inOrder(yield* kindsOf(server, sessionID, from), ["session.agent.selected", "session.model.selected"]))
        const again = (yield* server.sent).length
        failures.push(...expectStatus("same agent", yield* server.call(agent), 204), ...expectStatus("same model", yield* server.call(model), 204))
        yield* server.settle
        const said = yield* kindsOf(server, sessionID, again)
        if (said.join(",") !== "session.agent.selected") failures.push(`the switches to the same said: ${said.join(", ")}, not session.agent.selected alone`)
        return failures
      }),
  },
  {
    name: "viewing a session's idle says so once, never for an idle it has not had",
    routes: ["session.view"],
    kinds: ["session.viewed"],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        yield* prompt(server, sessionID, "Answer briefly.")
        yield* server.settle
        const info = yield* server.call(get(`/api/session/${sessionID}`))
        const idle = Option.getOrElse(
          Option.flatMap(read(Idle, info), (found) => Option.fromUndefinedOr(found.data.time.idle)),
          () => 0,
        )
        const from = (yield* server.sent).length
        const view = (at: number) => server.call(post(`/api/session/${sessionID}/view`, { idle: at }))
        const failures = [
          ...expectStatus("view past the idle", yield* view(idle + 60_000), 204),
          ...expectStatus("view", yield* view(idle), 204),
          ...expectStatus("view again", yield* view(idle), 204),
        ]
        yield* server.settle
        const viewed = (yield* kindsOf(server, sessionID, from)).filter((kind) => kind === "session.viewed")
        if (viewed.length !== 1) failures.push(`viewed ${viewed.length} times`)
        return failures
      }),
  },
  {
    name: "a background subagent call creates its child session and completes at once, the child running",
    routes: ["session.family.request.list"],
    kinds: ["session.created", "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.progress", "session.tool.success"],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        yield* prompt(server, sessionID, "spawn a worker")
        yield* server.settle
        const failures = inOrder(yield* kindsOf(server, sessionID), ["session.tool.input.started", "session.tool.called", "session.tool.success"])
        const created = (yield* server.sent).filter((event) => event.type === "session.created" && dataOf(event).parentID === sessionID)
        if (created.length !== 1) failures.push(`${created.length} children created`)
        failures.push(...expectStatus("family requests", yield* server.call(get(`/api/session/${sessionID}/family/request`)), 200))
        return failures
      }),
  },
  {
    name: "the catalog lists the agents, the models and the providers, and the server says its version",
    routes: ["agent.list", "model.list", "provider.list", "server.info"],
    kinds: [],
    run: (server) =>
      Effect.forEach(["/api/agent", "/api/model", "/api/provider", "/api/info"], (path) => Effect.map(server.call(get(path)), (answer) => expectStatus(path, answer, 200))).pipe(
        Effect.map((each) => each.flat()),
      ),
  },
  {
    name: "an RPC to a plugin the server has not loaded fails 400 rpc.unavailable; the goal RPC answers no goal",
    routes: ["rpc.call"],
    kinds: [],
    run: (server) =>
      Effect.gen(function* () {
        const sessionID = yield* server.session
        const missing = yield* server.call(post("/api/rpc/dotfiles-opencode.wake/pending", { input: { sessionIDs: [sessionID] } }))
        const goal = yield* server.call(post("/api/rpc/opencode.goal/get", { input: { sessionID } }))
        const failures = [...expectStatus("missing RPC", missing, 400), ...expectStatus("goal", goal, 200)]
        if (Option.isNone(read(Unavailable, missing))) failures.push(`missing RPC answered ${shown(missing)}`)
        if (Option.isNone(read(Goal, goal))) failures.push(`goal answered ${shown(goal)}`)
        return failures
      }),
  },
]

/** The routes the laws name, and the event kinds. */
export const ROUTES = new Set(LAWS.flatMap((law) => law.routes))
export const KINDS = new Set(LAWS.flatMap((law) => law.kinds))

/** A law's outcome line in a real run's result: `kept` or the failures, by its name. */
export const Outcome = Schema.Struct({ name: Schema.String, failures: Schema.Array(Schema.String) })
export const Result = Schema.fromJsonString(Schema.Struct({ outcomes: Schema.Array(Outcome) }))

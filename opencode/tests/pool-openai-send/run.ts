// Child process: real SDK and pool, scratch database and synthetic OAuth.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Array as Arr, Config, Data, Effect, FileSystem, Latch, Match, Option, Path, Predicate, Result, Schema, Scope, Stream } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { OpenCode as sdk } from "pool-fixture-sdk"
import { hangGuard } from "../hang-guard.ts"
import { quotaEpoch } from "../fake-chatgpt.ts"

const MODEL = { providerID: "openai", id: "gpt-6.2-fixture" }
const POOL = "dotfiles-opencode.pool"
const ACCESS = "synthetic-access"
const HOUR = 3_600_000
const FUTURE = 9_000
const Quote = Schema.Struct({
  ok: Schema.Boolean, measured: Schema.Boolean, eligible: Schema.optionalKey(Schema.Array(Schema.String)),
  retryAt: Schema.optionalKey(Schema.Finite),
  tracking: Schema.optionalKey(Schema.String),
})
type Quote = typeof Quote.Type
const RpcOutput = Schema.Struct({ output: Schema.optionalKey(Schema.Json), data: Schema.optionalKey(Schema.Json) })
const decodeCommit = Schema.decodeUnknownEffect(Schema.Struct({ held: Schema.Literal(true), until: Schema.Finite }))
const LogEvent = Schema.Struct({ type: Schema.String, data: Schema.optionalKey(Schema.Struct({
  at: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.Struct({ type: Schema.String, message: Schema.String })),
})) })
const Frame = Schema.Union([Schema.Struct({ event: LogEvent }), LogEvent])
const protocol = { id: POOL, methods: { pace: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const toQuote = Schema.decodeUnknownEffect(Quote)
const frameOf = Schema.decodeUnknownOption(Frame)
const routeStep = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String, attempt: Schema.Finite }))
class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ readonly message: string }> {}

interface Route { readonly kind: string; readonly sessionID: string; readonly step?: Schema.Json }
interface Title { result?: string }
interface HookContext {
  readonly session: { readonly hook: {
    (name: "title", hook: (event: Title) => Effect.Effect<void>): Effect.Effect<unknown>
    (name: "experimental.model.resolve", hook: (event: Route) => Effect.Effect<void>): Effect.Effect<unknown>
    (name: "experimental.ws.handshake", hook: (event: Route) => Effect.Effect<void>): Effect.Effect<unknown>
    (name: "http.request", hook: (event: Route) => Effect.Effect<void>): Effect.Effect<unknown>
  } }
  readonly rpc: (definition: typeof protocol) => { readonly pace: (input: Schema.JsonObject) => Effect.Effect<Schema.Json, Error> }
}
interface Client {
  readonly location: { readonly get: (input: Schema.JsonObject) => Effect.Effect<unknown, Error> }
  readonly session: {
    readonly create: (input: Schema.JsonObject) => Effect.Effect<{ readonly id: string }, Error>
    readonly prompt: (input: Schema.JsonObject) => Effect.Effect<unknown, Error>
  }
  readonly credential: {
    readonly create: (input: Schema.JsonObject) => Effect.Effect<{ readonly id: string }, Error>
    readonly remove: (input: Schema.JsonObject) => Effect.Effect<unknown, Error>
  }
  readonly rpc: { readonly call: (input: Schema.JsonObject) => Effect.Effect<typeof RpcOutput.Type, Error> }
  readonly experimental: { readonly session: {
    readonly log: (input: Schema.JsonObject) => Stream.Stream<Schema.Json, Error>
  } }
}
interface Configured {
  readonly database: { readonly path: string }
  readonly models: { readonly fetch: boolean }
  readonly events: { readonly persist: boolean }
  readonly log: { readonly level: string; readonly emit: (entry: { readonly message: string }) => void }
  readonly plugins: ReadonlyArray<{ readonly id: string; readonly effect: (ctx: HookContext) => Effect.Effect<void> }>
  readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
}
interface Sdk { readonly create: (options: Configured) => Effect.Effect<Client, Error, Scope.Scope> }
const Sdk = Schema.declare((value): value is Sdk => Predicate.hasProperty(value, "create") && Predicate.isFunction(value.create))
const Case = Schema.Literals(["http", "websocket", "late-http", "late-websocket", "api-http", "api-websocket", "cost",
  "retry-http", "retry-websocket", "signed-out-http", "fresh-spent", "fresh-free", "fresh-timeout"])
type Case = typeof Case.Type
const lateCase = (sample: Case) => sample.startsWith("late-")
const apiCase = (sample: Case) => sample.startsWith("api-")
const retryCase = (sample: Case) => sample.startsWith("retry-")
const freshCase = (sample: Case) => sample.startsWith("fresh-")
type Sample = { readonly at: number; readonly authorization: string; readonly transport: string }
interface Fake {
  readonly sample: Case
  readonly hold: boolean
  spent: boolean
  deadline: number
  readonly sent: Array<Sample>
  usage: number
  commit: Effect.Effect<void>
  upgrades: number
  fallback: number
  readonly measurement: { readonly started: Latch.Latch; readonly release: Latch.Latch; start: number; end: number }
}

const eventStream = (events: ReadonlyArray<Schema.Json>) => HttpServerResponse.text(
  `${events.map((event) => `data: ${serialize(event)}\n\n`).join("")}data: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } },
)
const chunk = (delta: Schema.JsonObject, suffix: Schema.JsonObject) => ({
  id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
  choices: [{ index: 0, delta, ...suffix }],
})
const socketFrames = (i: number): ReadonlyArray<Schema.Json> => {
  const response = { id: `resp_${i}` }
  const id = `msg_${i}`
  const text = "synthetic socket answer"
  const item = { type: "message", id, status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }] }
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", item },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_text.done", item_id: id, text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { ...response, output: [item] } },
  ]
}
const createFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("response.create") })))
const seconds = (ms: number) => Math.round(ms / 1_000)
const shortWindow = (fake: Fake, minutes: number) => ({
  used_percent: Match.value(fake.spent).pipe(Match.when(true, () => 100), Match.orElse(() => 0)),
  window_minutes: minutes,
  limit_window_seconds: minutes * 60,
  reset_at: seconds(fake.deadline),
})
const week = () => ({ used_percent: 20, window_minutes: 10_080, limit_window_seconds: 604_800, reset_at: seconds(quotaEpoch() + 40 * HOUR) })
const header = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  Option.getOrElse(Option.fromUndefinedOr(request.headers[name]), () => "")
const saw = (state: Fake, request: HttpServerRequest.HttpServerRequest, transport: string) =>
  state.sent.push({ at: quotaEpoch(), authorization: header(request, "authorization"), transport })

const upgrade = (state: Fake, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    state.upgrades += 1
    const socket = yield* request.upgrade
    const writer = yield* socket.writer
    const pull = yield* Socket.readerString(socket)
    yield* pull.pipe(
      Effect.flatMap((messages) => Effect.forEach(messages, (message) => Effect.gen(function* () {
        if (Option.isNone(createFrame(message))) return
        const i = saw(state, request, "websocket")
        if (retryCase(state.sample) && i === 2) {
          yield* state.commit
          yield* writer.write(serialize({ type: "error", code: "server_error", message: "synthetic retryable provider failure" }))
          return
        }
        if (state.hold && state.sample === "websocket" && i === 1) {
          state.spent = true
          state.deadline = quotaEpoch() + FUTURE
          yield* writer.write(serialize({ type: "codex.rate_limits", rate_limits: { primary: shortWindow(state, 300), secondary: week() } }))
        }
        yield* Effect.forEach(socketFrames(i), (frame) => writer.write(serialize(frame)), { discard: true })
      }), { discard: true })),
      Effect.forever,
      Effect.catchTag("SocketError", () => Effect.void),
    )
    return HttpServerResponse.empty()
  }).pipe(Effect.scoped)

const server = (state: Fake) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.url.endsWith("/usage")) {
    state.usage += 1
    if (request.headers["authorization"] !== `Bearer ${ACCESS}` || request.headers["chatgpt-account-id"] !== "fixture")
      return HttpServerResponse.text("no synthetic credential", { status: 401 })
    if (freshCase(state.sample)) {
      state.measurement.start = quotaEpoch()
      yield* state.measurement.started.open
      yield* state.measurement.release.await
      if (state.sample === "fresh-timeout") return HttpServerResponse.text("synthetic outage", { status: 503 })
      state.measurement.end = quotaEpoch()
    }
    return yield* HttpServerResponse.json({ plan_type: "pro", rate_limit: {
      limit_reached: state.spent, allowed: !state.spent, primary_window: shortWindow(state, 300), secondary_window: week(),
    } })
  }
  if (request.url.endsWith("/responses")) {
    if (request.headers["upgrade"] === "websocket") return yield* upgrade(state, request)
    state.fallback += 1
    return HttpServerResponse.text("unexpected fallback", { status: 500 })
  }
  if (!request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
  const i = saw(state, request, "http")
  if (retryCase(state.sample) && i === 1) {
    yield* state.commit
    return HttpServerResponse.text("synthetic retryable provider failure", { status: 500 })
  }
  return eventStream([chunk({ role: "assistant", content: "loopback answer" }, {}), chunk({}, { finish_reason: "stop" })])
}).pipe(Effect.orDie)

const closeOf = (event: typeof LogEvent.Type) => event.type === "session.execution.failed" || event.type === "session.execution.succeeded"
const sessionLog = (host: Client, id: string) => host.experimental.session.log({ sessionID: id, follow: true }).pipe(
  Stream.filterMap((value) => Result.fromOption(Option.map(frameOf(value), (frame) => {
    if ("event" in frame) return frame.event
    return frame
  }), () => "not a native session event")),
)
const prompt = (host: Client, id: string) => host.session.prompt({ sessionID: id, text: "original synthetic prompt" })
const fact = (host: Client, id: string, directory: string) =>
  host.rpc.call({ rpcID: POOL, method: "heldSend", input: { sessionID: id }, location: { directory } }).pipe(
    Effect.flatMap((result) => Option.match(
      Option.orElse(Option.fromUndefinedOr(result.output), () => Option.fromUndefinedOr(result.data)),
      { onNone: () => Effect.fail(new FixtureFailure({ message: "heldSend RPC returned no answer" })), onSome: (answer) => Effect.succeed(Option.some(answer)) },
    )),
  )
const transcript = (host: Client, state: Fake, id: string, directory: string, retry: { readonly reached: Latch.Latch; readonly observed: Latch.Latch }, replayAfterWarm = false) => Effect.gen(function* () {
  let during = Option.none<Schema.Json>()
  let deferred = Option.none<{ readonly at: number; readonly sends: number; readonly upgrades: number; readonly reason: string }>()
  const warm = state.sent.length
  const live = sessionLog(host, id)
  const log = Match.value(replayAfterWarm).pipe(
    Match.when(true, () => live.pipe(Stream.dropUntil(closeOf))),
    Match.orElse(() => live),
  )
  const final = yield* log.pipe(
    Stream.tap((event) => Effect.gen(function* () {
      const at = Option.fromUndefinedOr(event.data?.at)
      if (event.type !== "session.retry.scheduled" || event.data?.error?.type !== "route.deferred" || Option.isNone(at)) return
      if (Option.isNone(deferred)) {
        deferred = Option.some({ at: at.value, sends: state.sent.length - warm, upgrades: state.upgrades, reason: event.data.error.message })
        // Exercise a late consumer deliberately, with the retry parked at
        // routing until the read. This is not a claim about observer latency.
        if (state.sample === "late-http") yield* retry.reached.await
        during = yield* fact(host, id, directory)
      }
      state.spent = false
      state.deadline = at.value + HOUR
      yield* retry.observed.open
    })),
    Stream.filter(closeOf),
    Stream.runHead,
    Effect.timeout(hangGuard("local-fixture")),
  )
  if (Option.isNone(final)) return yield* new FixtureFailure({ message: "session log ended without the original execution's outcome" })
  return {
    outcome: final.value.type, message: Option.getOrElse(Option.fromUndefinedOr(final.value.data?.error?.message), () => ""),
    deferred: Option.getOrNull(deferred),
    during: Option.getOrNull(during),
  }
})

const writerFact = (host: Client, directory: string) =>
  host.rpc.call({ rpcID: "fixture.openai-send-hold", method: "read", input: {}, location: { directory } }).pipe(
    Effect.map((reply) => Option.fromUndefinedOr(reply.output)),
  )

const firstMeasure = (host: Client, state: Fake, id: string, directory: string) => Effect.gen(function* () {
  const began = quotaEpoch()
  yield* prompt(host, id)
  yield* state.measurement.started.await.pipe(Effect.timeout(hangGuard("local-fixture")))
  const before = state.sent.length
  if (state.sample !== "fresh-timeout") yield* state.measurement.release.open
  const observed = yield* sessionLog(host, id).pipe(
    Stream.filter((event) => closeOf(event) || (event.type === "session.retry.scheduled" && event.data?.error?.type === "route.deferred")),
    Stream.runHead, Effect.timeout(hangGuard("local-fixture")),
    Effect.ensuring(state.measurement.release.open),
  )
  const status = yield* host.rpc.call({ rpcID: POOL, method: "status", input: {}, location: { directory } })
  return {
    before, usage: state.usage, began, start: state.measurement.start, end: state.measurement.end, sent: state.sent,
    outcome: Option.getOrElse(Option.map(observed, ({ type }) => type), () => "missing"),
    message: Option.getOrElse(Option.flatMap(observed, ({ data }) => Option.fromUndefinedOr(data?.error?.message)), () => ""),
    status: Option.getOrNull(Option.orElse(Option.fromUndefinedOr(status.output), () => Option.fromUndefinedOr(status.data))),
    heldSend: Option.getOrNull(yield* fact(host, id, directory)),
  }
})

interface Target {
  readonly base: string
  readonly pool: string
  readonly sample: Case
  readonly host: Sdk
}
const run = (target: Target, hold: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(target.base, String(hold))
  yield* fs.makeDirectory(directory)
  const writer = path.join(target.base, "writer")
  const late = lateCase(target.sample)
  const api = apiCase(target.sample)
  const retry = retryCase(target.sample)
  const signedOut = target.sample === "signed-out-http"
  if (late || retry) yield* fs.makeDirectory(writer)
  const socket = target.sample.endsWith("websocket")
  const measurement = { started: yield* Latch.make(), release: yield* Latch.make(), start: 0, end: 0 }
  const state: Fake = { sample: target.sample, hold, spent: (target.sample === "http" && hold) || target.sample === "fresh-spent",
    deadline: quotaEpoch() + HOUR, sent: [], upgrades: 0, fallback: 0, usage: 0, commit: Effect.void, measurement }
  let expected = seconds(state.deadline) * 1_000
  yield* HttpServer.serveEffect(server(state))
  const httpd = yield* HttpServer.HttpServer
  const origin = HttpServer.formatAddress(httpd.address)
  const quotes: Array<Quote> = []
  const warnings: Array<string> = []
  const steps: Array<{ readonly id: string; readonly attempt: number }> = []
  let typed = false
  let commit: Effect.Effect<void> = Effect.void
  let wrote = false
  const retryRead = { reached: yield* Latch.make(), observed: yield* Latch.make() }
  const probe = (ctx: HookContext) => Effect.gen(function* () {
    yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Fixture" }))
    if (target.sample === "late-websocket") yield* ctx.session.hook("experimental.ws.handshake", (event) =>
      Effect.suspend(() => {
        if (event.kind !== "primary" || quotes.length < 2 || wrote) return Effect.void
        wrote = true
        return commit
      }),
    )
    if (target.sample === "late-http") yield* ctx.session.hook("http.request", (event) =>
      Effect.suspend(() => {
        if (event.kind !== "primary" || quotes.length === 0 || wrote) return Effect.void
        wrote = true
        return commit
      }),
    )
    yield* ctx.session.hook("experimental.model.resolve", (event) =>
      Effect.gen(function* () {
        if (event.kind !== "primary") return
        const step = routeStep(event.step)
        if (Option.isSome(step)) steps.push(step.value)
        const retryAfterHold = Match.value(retry).pipe(Match.when(true, () => 3), Match.orElse(() => 2))
        if (hold && !api && Option.exists(step, ({ attempt }) => attempt >= retryAfterHold)) {
          yield* retryRead.reached.open
          yield* retryRead.observed.await
        }
        const limit = Match.value(hold && socket).pipe(Match.when(true, () => 2), Match.orElse(() => 1))
        if (freshCase(target.sample) || quotes.length >= limit) return
        typed = Option.isSome(step)
        if (state.spent && !socket) state.deadline = quotaEpoch() + FUTURE
        const input = { providerID: MODEL.providerID, model: MODEL.id, sessionID: event.sessionID, dispatch: true }
        const quote = yield* ctx.rpc(protocol).pace(input).pipe(Effect.flatMap(toQuote))
        quotes.push(quote)
      }).pipe(Effect.orDie))
  })
  const provider = Match.value(socket).pipe(
    Match.when(true, () => ({ package: "@opencode/ai/providers/openai", transport: "websocket" })),
    Match.orElse(() => ({ package: "@opencode/ai/providers/openai-compatible", transport: "http" })),
  )
  const configured: Configured = {
    database: { path: path.join(directory, "fixture.db") }, models: { fetch: false }, events: { persist: true },
    log: { level: "warn", emit: (entry) => { warnings.push(entry.message) } },
    plugins: [{ id: "fixture.pool-openai", effect: probe }],
    config: { directory, project: false, content: serialize({
      model: `${MODEL.providerID}/${MODEL.id}`,
      providers: { openai: {
        package: provider.package, settings: { baseURL: origin, transport: provider.transport,
          apiKey: Option.getOrElse(Option.filter(Option.some("synthetic-api-key"), () => signedOut), () => ACCESS) },
        models: { [MODEL.id]: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
      } },
      enabled_providers: ["openai"],
      plugins: [{ package: target.pool, options: {
        providers: {}, paced: { openai: "openai" }, sweepMinutes: 0, resets: false,
        usageURL: `${origin}/usage`,
        ...Option.match(Option.filter(Option.some("signin"), () => signedOut), { onNone: () => ({}), onSome: (fixtureKind) => ({ fixtureKind }) }),
      } }],
    }) },
  }
  const signIn = (host: Client) => host.credential.create({ integrationID: "openai", activate: true, value: {
    type: "oauth", methodID: "synthetic-fixture", refresh: "synthetic-refresh", access: ACCESS, expires: quotaEpoch() + HOUR,
    metadata: { accountID: "fixture" },
  } })
  // The open quote uses the healthy fake usage window. Start the separate
  // hold's clock at the write it is supposed to simulate, not at SDK boot.
  const lastsMs = Match.value(target.sample).pipe(
    Match.when("signed-out-http", () => HOUR),
    Match.when(Match.is("retry-http", "retry-websocket"), () => 2 * FUTURE),
    Match.orElse(() => FUTURE),
  )
  const commitIn = (host: Client, at = writer) => host.rpc.call({
    rpcID: "fixture.openai-send-hold", method: "commit", input: { lastsMs }, location: { directory: at },
  }).pipe(
    Effect.flatMap(({ output, data }) => decodeCommit(Option.getOrNull(Option.orElse(Option.fromUndefinedOr(output), () => Option.fromUndefinedOr(data))))),
    Effect.tap(({ until }) => Effect.sync(() => { expected = until })),
  )
  let signedOutHold = Option.none<Schema.Json>()
  if (signedOut) signedOutHold = yield* Effect.gen(function* () {
    const host = yield* target.host.create(configured)
    const login = yield* signIn(host)
    const warm = yield* host.session.create({ location: { directory }, model: MODEL, title: "Warm" })
    yield* prompt(host, warm.id)
    const before = yield* transcript(host, state, warm.id, directory, retryRead)
    if (before.outcome !== "session.execution.succeeded" || state.sent[0]?.authorization !== `Bearer ${ACCESS}`)
      return yield* new FixtureFailure({ message: "OAuth warm-up did not send on the synthetic pooled login" })
    yield* commitIn(host, directory).pipe(Effect.mapError((error) => new FixtureFailure({ message: `sign-out hold commit: ${error.message}; ${warnings.join("\n")}` })))
    const fact = yield* writerFact(host, directory)
    yield* host.credential.remove({ credentialID: login.id })
    state.sent.length = 0
    quotes.length = 0
    steps.length = 0
    return fact
  }).pipe(Effect.scoped)
  const host = yield* target.host.create(configured)
  if (!api && !signedOut) yield* signIn(host)
  if (late || retry) {
    yield* host.location.get({ location: { directory: writer } })
    commit = commitIn(host).pipe(Effect.asVoid, Effect.orDie)
    if (retry) state.commit = commit
  }
  const { id } = yield* host.session.create({ location: { directory }, model: MODEL, title: "Fixture" })
  if (freshCase(target.sample)) return yield* firstMeasure(host, state, id, directory)
  const warm = Arr.empty<Sample>()
  if (hold && socket && !api) {
    yield* prompt(host, id)
    const first = yield* transcript(host, state, id, directory, retryRead)
    if (first.outcome !== "session.execution.succeeded" || state.sent.length !== 1)
      return yield* new FixtureFailure({ message: `warm control failed: ${serialize({ ...first, sent: state.sent, warnings })}` })
    warm.push(...state.sent)
  }
  // The durable log replays the first execution, so the second observation
  // skips exactly its first terminal event, never a sleep or timing guess.
  yield* prompt(host, id)
  const last = yield* transcript(host, state, id, directory, retryRead, warm.length > 0)
  const after = yield* fact(host, id, directory)
  const usageBeforeCost = state.usage
  const cost = yield* Match.value(target.sample).pipe(
    Match.when("cost", () => Effect.gen(function* () {
      const reply = yield* host.rpc.call({ rpcID: "fixture.openai-send-hold", method: "cost", input: {}, location: { directory } })
      return Option.orElse(Option.fromUndefinedOr(reply.output), () => Option.fromUndefinedOr(reply.data))
    })),
    Match.orElse(() => Effect.succeed(Option.none<Schema.Json>())),
  )
  const committed = yield* Match.value(late || retry).pipe(
    Match.when(true, () => writerFact(host, writer)),
    Match.orElse(() => Effect.succeed(signedOutHold)),
  )
  return {
    ...last, typed, steps, warm, sent: state.sent.slice(warm.length), upgrades: state.upgrades, fallback: state.fallback, warnings,
    ...Option.match(Arr.head(quotes), { onNone: () => ({}), onSome: (initial) => ({ initial }) }),
    ...Option.match(Arr.last(quotes), { onNone: () => ({}), onSome: (quote) => ({ quote }) }),
    after: Option.getOrNull(after), committed: Option.getOrNull(committed),
    expected, cost: Option.getOrNull(cost), costUsageReads: state.usage - usageBeforeCost,
  }
}).pipe(Effect.scoped, Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })))

const main = Effect.gen(function* () {
  const base = yield* Config.String("POOL_FIXTURE_BASE")
  const pool = yield* Config.String("POOL_FIXTURE_PLUGIN")
  const selected = yield* Config.String("POOL_FIXTURE_SAMPLE")
  const sample = yield* Schema.decodeUnknownEffect(Case)(selected)
  const host = yield* Schema.decodeUnknownEffect(Sdk)(sdk)
  const held = yield* run({ base, pool, sample, host }, true)
  const open = yield* Match.value(sample).pipe(
    Match.when("http", () => run({ base, pool, sample, host }, false).pipe(Effect.map(Option.some))),
    Match.orElse(() => Effect.succeed(Option.none())),
  )
  return { held, open: Option.getOrNull(open) }
})
BunRuntime.runMain(main.pipe(Effect.flatMap((result) => FileSystem.FileSystem.use((fs) =>
  Config.String("POOL_FIXTURE_RESULT").pipe(Effect.flatMap((path) => fs.writeFileString(path, serialize(result)))),
)), Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))))

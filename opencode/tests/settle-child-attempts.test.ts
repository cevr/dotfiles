/** @reads cmd/kernel/fixtures/settle-child-pace/** cmd/kernel/server.ts cmd/orchestrate/server.ts cmd/wake/server.ts mods/subagents/solid/native-row.fixture.ts */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Clock, Config, Console, DateTime, Deferred, Effect, Layer, Option, Path, Predicate, Ref, Schema, Scope, Stream } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { Answer, chatEvents } from "../sim/verify-model.ts"
import { message, type Reads, type SessionInfo, type ShellInfo } from "../mods/subagents/opencode/view.ts"
import { subagents, visible } from "../mods/subagents/subagent-row.ts"
import { Diagnostic, Phase, Undetermined } from "../mods/kernel/child-lifecycle.ts"
import { readMark, type MarkRead } from "../mods/wake/latch.ts"
import { owned, released } from "./owned.ts"
import { forkRuns, parentEnv, scratch } from "./scratch.ts"

interface HostEvent {
  readonly type: string
  readonly id?: string
  readonly created?: number
  readonly durable?: { readonly seq: number; readonly aggregateID: string }
  readonly data?: {
    readonly id?: string
    readonly sessionID?: string
    readonly info?: ShellInfo
    readonly at?: number
    readonly attempt?: number
    readonly error?: { readonly type: string }
    readonly metadata?: Readonly<Record<string, Schema.Json>>
    readonly inboxID?: string
    readonly child?: string
    readonly revision?: number
    readonly item?: { readonly type: string; readonly payload: { readonly metadata?: Readonly<Record<string, Schema.Json>> } }
  }
}

interface Embedded {
  readonly rpc: unknown
  readonly sessions: {
    readonly create: (input: { location: { directory: string }; title?: string }) => Promise<{ id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => PromiseLike<object>
    readonly list: (input: { parentID: string }) => Promise<{ data: ReadonlyArray<SessionInfo> }>
    readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
    readonly context: (input: { sessionID: string }) => Promise<ReadonlyArray<Schema.Json>>
    readonly inbox: {
      readonly list: (input: { sessionID: string }) => Promise<ReadonlyArray<{ type: string; payload: object }>>
      readonly cancel: (input: { sessionID: string; inboxID: string }) => Promise<void>
    }
    readonly synthetic: (input: { sessionID: string; text: string; metadata: Schema.JsonObject; resume: false }) => Promise<{ id: string }>
  }
  readonly experimental: { readonly session: {
    readonly wait: (input: { sessionID: string }) => PromiseLike<object>
    readonly log: (input: { sessionID: string; follow: false }) => AsyncIterable<HostEvent>
  } }
  readonly events: { readonly subscribe: (options?: { readonly signal: AbortSignal }) => AsyncIterable<HostEvent> }
  readonly shell: {
    readonly create: (input: { command: string; location: { directory: string }; metadata: Schema.JsonObject }) => Promise<{ data: ShellInfo }>
  }
  readonly close: () => Promise<void>
}

interface SdkOptions {
  readonly database: { readonly path: string }
  readonly events: { readonly persist: true }
  readonly models: { readonly fetch: false }
  readonly config: Schema.JsonObject
}

const Sdk = Schema.declare((input): input is { readonly OpenCode: { create(options: SdkOptions): Promise<Embedded> } } =>
  Predicate.isObject(input) && Predicate.isObject(input.OpenCode) && Predicate.isFunction(input.OpenCode.create),
)
class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", { message: Schema.String }) {}
const fault = (message: string) => new FixtureError({ message })
const promised = <A>(message: string, read: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => {
    if (Predicate.isError(error)) return fault(`${message}: ${error.message.slice(0, 400)}`)
    return fault(message)
  } })

interface SolidFixture {
  readonly liveEvents: (events: Embedded["events"]) => { readonly listen: NonNullable<Reads["listen"]>; readonly listeners: () => number }
  readonly mountRows: (data: Reads, base: string, root: string, child: string, client: Embedded) => {
    readonly close: () => void
    readonly ready: Effect.Effect<void>
    readonly rows: () => ReturnType<typeof subagents>
  }
  readonly replayRows: (info: SessionInfo, root: string, shell: ShellInfo, events: ReadonlyArray<HostEvent>) => ReadonlyArray<string>
  readonly openBarrier: (client: Embedded, base: string, root: string, child: string, info: SessionInfo, shell: ShellInfo) => Effect.Effect<Barrier, unknown, Scope.Scope>
}
type Display = ReadonlyArray<{ readonly state: string; readonly update: string }>
interface Barrier {
  readonly notify: (details: HostEvent) => void
  readonly hideShell: () => void
  readonly next: Effect.Effect<{ readonly revision: number; readonly release: Effect.Effect<boolean> }>
  readonly initial: number
  readonly ready: Effect.Effect<void>
  readonly live: Display
  readonly snapshot: () => Display
  readonly revision: () => number
}
const fixtureModule = Schema.declare((value): value is SolidFixture =>
  Predicate.isObject(value) && Predicate.isFunction(value.liveEvents) && Predicate.isFunction(value.mountRows) &&
  Predicate.isFunction(value.replayRows) && Predicate.isFunction(value.openBarrier),
)
const solidFixture = Effect.gen(function* () {
  const path = yield* Path.Path
  const module = yield* path.fromFileUrl(new URL("../mods/subagents/solid/native-row.fixture.ts", import.meta.url))
  return yield* promised("Solid row harness import failed", () => loadSdk(module)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(fixtureModule)))
})

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const denied = "SCRIPTED_CHILD_DENIAL"
const earlierExit = "SCRIPTED_EARLIER_EXIT"
const retryChild = "SCRIPTED_CHILD_RETRY"
const silentChild = "SCRIPTED_SILENT_CHILD"
const hasInput = (text: string, marker: string) => text.split("\n").includes(marker)

const ContextTools = Schema.Array(Schema.Struct({ type: Schema.String, content: Schema.optionalKey(Schema.Array(Schema.Unknown)) }))
const ToolPart = Schema.Struct({
  type: Schema.Literal("tool"), name: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    content: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
})
const takeAnswer = (context: ReadonlyArray<Schema.Json>, name: string) => {
  const content = Schema.decodeUnknownSync(ContextTools)(context)
    .filter((item) => item.type === "assistant")
    .flatMap((item) => Option.getOrElse(Option.fromUndefinedOr(item.content), () => []))
  const tool = content.findLast((part): part is typeof ToolPart.Type => Schema.is(ToolPart)(part) && part.name === name)
  return Option.getOrElse(Option.map(Option.fromUndefinedOr(tool?.state.content), (parts) => parts.map((part) => part.text).join("\n")),
    () => Option.getOrElse(Option.fromUndefinedOr(tool?.state.error?.message), () => ""))
}

// Pinned openai-chat.ts joins uncached text into strings. An assistant
// message with tool calls and no text has null content. This fixture has no
// media or cache breakpoints and deliberately does not admit those variants.
const Wire = Schema.Struct({
  messages: Schema.Array(Schema.Union([
    Schema.Struct({ role: Schema.Literals(["system", "user"]), content: Schema.String }),
    Schema.Struct({ role: Schema.Literal("tool"), content: Schema.String, tool_call_id: Schema.String }),
    Schema.Struct({
      role: Schema.Literal("assistant"), content: Schema.NullOr(Schema.String),
      tool_calls: Schema.optionalKey(Schema.Array(Schema.Struct({
        id: Schema.String, type: Schema.Literal("function"),
        function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
      }))),
    }),
  ])),
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ function: Schema.optionalKey(Schema.Struct({ name: Schema.String })) }))),
})
const messageText = (item: typeof Wire.Type.messages[number]) => {
  if (Predicate.isString(item.content)) return item.content
  return ""
}
const modelFor = (gate: string) => Effect.gen(function* () {
  const state = yield* Ref.make({ requests: 0, filtered: false, retried: false, content: "", script: "not reached", tools: "" })
  const affirmExit = yield* Deferred.make<boolean>()
  const finishRetry = yield* Deferred.make<boolean>()
  const failSilent = yield* Deferred.make<boolean>()
  yield* HttpServer.serveEffect(Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(Wire).pipe(Effect.tapError(() =>
      Ref.update(state, (before) => ({ ...before, script: "wire rejected" })),
    ))
    const system = body.messages.find((item) => item.role === "system")
    const title = Boolean(system && messageText(system).includes("You name conversations"))
    const latest = body.messages.findLastIndex((item) => item.role === "user")
    const prompt = Option.getOrElse(Option.map(Arr.get(body.messages, latest), messageText), () => "")
    const shellAnswered = body.messages.slice(latest + 1).some((item) => item.role === "tool")
    const answer = fixtureAnswer(prompt, title, shellAnswered, gate)
    const retry = !title && hasInput(prompt, retryChild)
    const silent = !title && hasInput(prompt, silentChild)
    const earlier = !title && hasInput(prompt, earlierExit)
    const { id, filter, throttle } = yield* Ref.modify(state, (prev) => {
      const requests = prev.requests + 1
      const filter = !prev.filtered && !title && hasInput(prompt, denied) && shellAnswered
      const throttle = retry && !prev.retried
      const content = contentKind(system)
      const tools = Option.getOrElse(Option.fromUndefinedOr(body.tools), () => []).flatMap((tool) => Option.toArray(Option.fromUndefinedOr(tool.function?.name)))
        .filter((name) => ["kernel", "subagent", "subagents", "shell"].includes(name)).join(",")
      return [
        { id: `fixture${requests}`, filter, throttle },
        { requests, filtered: prev.filtered || filter, retried: prev.retried || throttle, content, script: answer._tag, tools },
      ]
    })
    if (throttle) return HttpServerResponse.text('{"error":{"message":"Fixture throttled","type":"rate_limit_error"}}', {
      status: 429, contentType: "application/json", headers: { "retry-after-ms": "100" },
    })
    if (retry) yield* Deferred.await(finishRetry)
    if (silent && shellAnswered) yield* Deferred.await(failSilent)
    if (earlier) yield* Deferred.await(affirmExit)
    let events = chatEvents(answer, "sim-model", id)
    if (filter || earlier || (silent && shellAnswered)) events = chatEvents(Answer.Text({ text: "" }), "sim-model", id).map((event) =>
      event.replace('"finish_reason":"stop"', '"finish_reason":"content_filter"'),
    )
    return HttpServerResponse.text(events.join(""), { contentType: "text/event-stream" })
  }).pipe(Effect.orDie))
  const server = yield* HttpServer.HttpServer
  return { baseURL: `${HttpServer.formatAddress(server.address)}/v1`, read: Ref.get(state),
    affirmExit: Deferred.succeed(affirmExit, true), finishRetry: Deferred.succeed(finishRetry, true),
    failSilent: Deferred.succeed(failSilent, true) }
})

const contentKind = (system?: typeof Wire.Type.messages[number]) => {
  if (Predicate.isString(system?.content)) return "string"
  return "missing"
}
const VerifyCall = Schema.Struct({ tool: Schema.String, input: Schema.JsonObject })
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(VerifyCall))
const fixtureAnswer = (prompt: string, title: boolean, answered: boolean, gate: string) => {
  if (title) return Answer.Text({ text: "Fixture title" })
  if ((hasInput(prompt, denied) || hasInput(prompt, silentChild)) && !answered)
    return Answer.Call({ id: "fixture_shell", tool: "shell", input: { command: `cat '${gate}'`, background: true } })
  const line = prompt.split("\n").find((item) => item.startsWith("fixture-call "))
  if (!answered && line) {
    const request = decodeCall(line.slice("fixture-call ".length))
    if (Option.isSome(request)) return Answer.Call({ id: "fixture_call", ...request.value })
  }
  return Answer.Text({ text: "Fixture answered" })
}

const fixtureCall = (tool: string, input: Schema.JsonObject) => `fixture-call ${encode({ tool, input })}`
const command = Effect.fn("LifecycleFixture.command")(function* (file: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(ChildProcess.make(file, args, { forceKillAfter: "3 seconds" }))
  if (Number(code) !== 0) return yield* fault(`fixture command ${file} exited ${code}`)
})

const ask = Effect.fn("LifecycleFixture.ask")(function* (host: Embedded, sessionID: string, text: string) {
  yield* promised("prompt failed", () => host.sessions.prompt({ sessionID, text }))
  yield* promised("wait failed", () => host.experimental.session.wait({ sessionID }))
  return yield* promised("context read failed", () => host.sessions.context({ sessionID }))
})

const observeUntil = Effect.fn("LifecycleFixture.observeUntil")(function* (events: AsyncIterator<HostEvent>, name: string, accept: (event: HostEvent) => boolean) {
  for (;;) {
    const event = yield* promised(`event stream failed waiting for ${name}`, () => events.next())
    if (event.done) return yield* fault(`lifecycle event stream closed waiting for ${name}`)
    if (accept(event.value)) return event.value
  }
})

const loadSdk = (file: string) => import(file)

const pluginConfig = (cmd: string, base: string, join: Path.Path["join"], opensAt: number): ReadonlyArray<Schema.JsonObject> => [
  { package: join(cmd, "kernel"), options: { direct: ["subagents", "shell", "fixture_shell_suppress"] } },
  { package: join(cmd, "wake"), options: { backstop: "off" } },
  { package: join(cmd, "orchestrate"), options: { codex: false, log: join(base, "calls.jsonl") } },
  { package: join(cmd, "kernel", "fixtures", "settle-child-pace"), options: { opensAt } },
]

const host = Effect.fn("LifecycleFixture.host")(function* (
  baseURL: string, base: string, fork: string, plugins: ReadonlyArray<Schema.JsonObject>,
) {
  const path = yield* Path.Path
  const sdk = yield* promised("pinned SDK import failed", () => loadSdk(path.join(fork, "packages/sdk/src/index.ts"))).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Sdk)),
  )
  const provider = {
    name: "Sim", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL, apiKey: "fixture" },
    models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
  }
  return yield* Effect.acquireRelease(
    promised("real OpenCode boot failed", () => sdk.OpenCode.create({
      database: { path: path.join(base, "fixture.sqlite") }, events: { persist: true }, models: { fetch: false },
      config: { directory: base, project: false, content: encode({
        model: "sim/sim-model", providers: { sim: provider },
        plugins,
      }) },
    })),
    (instance) => Effect.promise(() => instance.close()),
  )
})

const childEvent = (name: string, child: string) => (event: HostEvent) => event.type === name && event.data?.sessionID === child
const point = (event: HostEvent) => Option.getOrElse(Option.fromUndefinedOr(event.durable?.seq), () => -1)
const eventPoint = (event: HostEvent) => ({ id: event.id || "", seq: point(event), at: Number(event.created) })
const handle = (child: string) => fixtureCall("kernel", { code: `JSON.stringify((await tools.subagent.handle(${encode(child)})).observation)` })
const launchChild = (description: string, prompt: string) => `await tools.subagent(${encode({ agent: "worker", description, prompt })})`
const nextEvent = (events: AsyncIterator<HostEvent>, name: string, accept: (event: HostEvent) => boolean) =>
  observeUntil(events, name, accept).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(fault(`missing fixture event: ${name}`)) }))
const childOf = Effect.fn("LifecycleFixture.childOf")(function* (instance: Embedded, root: string, launch: ReadonlyArray<Schema.Json>) {
  const children = yield* promised("child list failed", () => instance.sessions.list({ parentID: root }))
  return yield* Effect.fromOption(Arr.head(children.data)).pipe(Effect.mapError(() => fault(`child was not created: ${takeAnswer(launch, "kernel")}`)))
})

const heldChild = Effect.fn("LifecycleFixture.heldChild")(function* (instance: Embedded, base: string, title: string) {
  const { id: root } = yield* promised("held parent was not created", () => instance.sessions.create({ location: { directory: base }, title }))
  const launch = yield* ask(instance, root, fixtureCall("kernel", {
    code: `const kept = ${launchChild("Held fixture", "Held fixture body")}; JSON.stringify(kept.observation)`,
  }))
  const { id: child } = yield* childOf(instance, root, launch)
  const actual = yield* promised("held child snapshot lost", () => instance.sessions.get({ sessionID: child }))
  const rebuilt = yield* ask(instance, root, handle(child))
  const listed = yield* ask(instance, root, fixtureCall("subagents", { action: "list" }))
  const mark = yield* knownRecheck(readMark(actual.metadata))
  return { root, child, mark: encode(mark), launch: takeAnswer(launch, "kernel"), rebuilt: takeAnswer(rebuilt, "kernel"), listed: takeAnswer(listed, "subagents") }
})

const markedTime = (read: MarkRead) => {
  if (read._tag === "Unreadable") return Option.none()
  const { at, hold, opensAt, recheckAt } = read.mark
  if (hold !== "pace") return Option.none()
  return Option.map(Option.fromUndefinedOr(recheckAt), (recheckAt) => ({ at, hold, opensAt, recheckAt }))
}
const knownRecheck = (read: MarkRead) => Effect.fromOption(markedTime(read)).pipe(Effect.mapError(() => fault("Wake's mark has no pace recheck")))

const eventStream = Effect.fn("LifecycleFixture.eventStream")(function* (instance: Embedded) {
  const events = instance.events.subscribe()[Symbol.asyncIterator]()
  yield* nextEvent(events, "server.connected", (event) => event.type === "server.connected")
  return events
})

const timedHold = Effect.fn("LifecycleFixture.timedHold")(function* (instance: Embedded, base: string) {
  const events = yield* eventStream(instance)
  const initial = yield* heldChild(instance, base, "Fixture short hold")
  const mark = yield* decodeMark(initial.mark)
  const heldAgain = yield* observeUntil(events, "re-hold metadata", (event) => {
    if (!childEvent("session.metadata.updated", initial.child)(event)) return false
    const updated = markedTime(readMark(event.data?.metadata))
    return Option.exists(updated, (value) => value.recheckAt > mark.recheckAt)
  }).pipe(Effect.timeout("5 seconds"))
  const snapshot = yield* promised("re-held child lost", () => instance.sessions.get({ sessionID: initial.child }))
  const rebuilt = yield* ask(instance, initial.root, handle(initial.child))
  const listed = yield* ask(instance, initial.root, fixtureCall("subagents", { action: "list" }))
  const data = yield* knownRecheck(readMark(heldAgain.data?.metadata))
  const actual = yield* knownRecheck(readMark(snapshot.metadata))
  return {
    ...initial, reheldMark: encode(actual),
    reheldAt: data.recheckAt, afterRehold: takeAnswer(rebuilt, "kernel"), listedAfterRehold: takeAnswer(listed, "subagents"),
  }
})

const observedRetry = Effect.fn("LifecycleFixture.observedRetry")(function* (instance: Embedded, base: string, release: Effect.Effect<boolean>) {
  const events = yield* eventStream(instance)
  const { id: root } = yield* promised("retry parent was not created", () => instance.sessions.create({ location: { directory: base } }))
  const launch = yield* ask(instance, root, fixtureCall("kernel", { code: launchChild("Fixture retry", retryChild) }))
  const { id: child } = yield* childOf(instance, root, launch)
  const scheduled = yield* nextEvent(events, "native scheduled retry", childEvent("session.retry.scheduled", child))
  const read = yield* ask(instance, root, handle(child))
  yield* release
  yield* nextEvent(events, "retry success", childEvent("session.execution.succeeded", child))
  return {
    child, read: takeAnswer(read, "kernel"), attempt: Number(scheduled.data?.attempt),
    at: Number(scheduled.data?.at), error: scheduled.data?.error?.type || "",
  }
})

const earlierFailure = Effect.fn("LifecycleFixture.earlierFailure")(function* (instance: Embedded, base: string, gate: string, release: Effect.Effect<boolean>) {
  const events = yield* eventStream(instance)
  const { id: root } = yield* promised("earlier-shell parent was not created", () => instance.sessions.create({ location: { directory: base } }))
  const launch = yield* ask(instance, root, fixtureCall("kernel", { code: launchChild("Fixture earlier exit", earlierExit) }))
  const { id: child } = yield* childOf(instance, root, launch)
  const shell = yield* nativeShell(instance, base, gate, child)
  yield* nextEvent(events, "earlier shell created", (event) => event.type === "shell.created" && event.data?.info?.id === shell.id)
  yield* releaseShell(gate)
  const exit = yield* nextEvent(events, "earlier shell exited", (event) => event.type === "shell.exited" && event.data?.id === shell.id)
  yield* release
  const terminal = yield* nextEvent(events, "failure after exit", childEvent("session.execution.failed", child))
  const context = yield* ask(instance, root, handle(child))
  const rows = yield* realRows(instance, base, root, child, context, Option.none(), Number(terminal.created) + 1)
  return { row: rows.row, shown: rows.visible, ended: rows.ended, remount: rows.remount, exit: Number(exit.created), terminal: eventPoint(terminal), observation: takeAnswer(context, "kernel") }
})

const releaseShell = (gate: string) => command("sh", ["-c", 'printf ready > "$1"', "fixture", gate]).pipe(
  Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(fault("child shell never opened the FIFO")) }),
)
const nativeShell = (instance: Embedded, base: string, gate: string, child: string) =>
  promised("unwatched native shell did not start", () => instance.shell.create({
    command: `cat '${gate}'`, location: { directory: base }, metadata: { sessionID: child, background: true },
  })).pipe(Effect.map(({ data }) => data))

const beginBarriers = Effect.fn("LifecycleFixture.beginBarriers")(function* (instance: Embedded, base: string, root: string, child: string, info: SessionInfo, shell: ShellInfo) {
  const { openBarrier } = yield* solidFixture
  return yield* Effect.forEach(["shell-first", "owner-first"], (order) => Effect.gen(function* () {
    const barrier = yield* openBarrier(instance, base, root, child, info, shell)
    yield* Effect.sync(() => barrier.notify({ type: "server.connected" }))
    const stale = yield* barrier.next
    return { order, barrier, stale }
  }), { concurrency: 2 })
})

const finishBarriers = Effect.fn("LifecycleFixture.finishBarriers")(function* (
  cases: Effect.Success<ReturnType<typeof beginBarriers>>, exit: HostEvent, change: HostEvent,
) {
  return yield* Effect.forEach(cases, ({ order, barrier, stale }) => Effect.gen(function* () {
    const raw = () => { barrier.hideShell(); barrier.notify(exit) }
    const owner = () => barrier.notify(change)
    if (order === "shell-first") raw()
    else owner()
    const acrossFirst = barrier.snapshot()
    if (order === "shell-first") owner()
    else raw()
    yield* stale.release
    const pending = yield* barrier.next
    const outstanding = barrier.snapshot()
    yield* pending.release
    yield* barrier.ready
    return {
      order, live: barrier.live, acrossFirst, outstanding, after: barrier.snapshot(),
      old: stale.revision, current: pending.revision, accepted: Number(barrier.revision()),
    }
  }), { concurrency: 2 })
})

/** The native kill action marks the result answered. Invoke it without a
 * new child execution so no newer execution fact masks the silent gap. */
const silentExit = Effect.fn("LifecycleFixture.silentExit")(function* (
  instance: Embedded, base: string, failChild: Effect.Effect<boolean>,
) {
  const events = yield* eventStream(instance)
  const { id: root } = yield* promised("silent-shell parent was not created", () => instance.sessions.create({ location: { directory: base } }))
  const launch = yield* ask(instance, root, fixtureCall("kernel", { code: launchChild("Fixture silent shell", silentChild) }))
  const { id: child } = yield* childOf(instance, root, launch)
  const created = yield* nextEvent(events, "silent shell created", (event) => event.type === "shell.created" && event.data?.info?.metadata.sessionID === child)
  const shell = yield* Effect.fromOption(Option.fromUndefinedOr(created.data?.info)).pipe(Effect.mapError(() => fault("no native silent shell")))
  yield* failChild
  const terminal = yield* nextEvent(events, "silent shell's execution failed", childEvent("session.execution.failed", child))
  const snapshot = yield* promised("silent child snapshot lost", () => instance.sessions.get({ sessionID: child }))
  const barriers = yield* beginBarriers(instance, base, root, child, snapshot, shell)
  const killed = yield* ask(instance, root, fixtureCall("fixture_shell_suppress", { child, shellID: shell.id }))
  const exit = yield* nextEvent(events, "silent shell exited", (event) => event.type === "shell.exited" && event.data?.id === shell.id)
  const rebuilt = yield* ask(instance, root, handle(child))
  const direct = yield* ask(instance, root, fixtureCall("subagents", { action: "get", sessionID: child }))
  const change = yield* nextEvent(events, "owner persisted an exit", (event) =>
    event.type === "rpc.dotfiles-opencode.kernel.rows.changed" && event.data?.child === child,
  )
  const scheduled = yield* finishBarriers(barriers, exit, change)
  const { replayRows } = yield* solidFixture
  const rows = replayRows(snapshot, root, shell, [created, terminal, exit])
  const suppressed = yield* realRows(instance, base, root, child, direct, Option.none(), Number(exit.created) + 1)
  const pending = yield* promised("silent child inbox lost", () => instance.sessions.inbox.list({ sessionID: child }))
  // A separate controlled admission uses the same native inbox producer,
  // without waking immediately, so the public tool can sample the gap.
  const admitted = yield* promised("native inbox admission failed", () => instance.sessions.synthetic({
    sessionID: child, text: "Fixture shell result", metadata: { source: "shell", shellID: shell.id }, resume: false,
  }))
  const gap = yield* ask(instance, root, handle(child))
  const gapRows = yield* realRows(instance, base, root, child, gap, Option.none(), Number(exit.created) + 1)
  return {
    root, child, inboxID: admitted.id, shellID: shell.id, exit: { id: exit.id || "", at: Number(exit.created) },
    observation: takeAnswer(rebuilt, "kernel"), direct: takeAnswer(direct, "subagents"),
    pending: pending.length, rows, suppressed, scheduled, killed: takeAnswer(killed, "fixture_shell_suppress"),
    gap: takeAnswer(gap, "kernel"), gapRows: gapRows.visible, admittedRemount: gapRows.remount,
  }
})

const shellTrace = Effect.fn("LifecycleFixture.shellTrace")(function* (
  events: AsyncIterator<HostEvent>, child: string, shell: HostEvent, failure: HostEvent,
) {
  const shellID = shell.data?.info?.id
  const atExit = (event: HostEvent) => event.type === "shell.exited" && event.data?.id === shellID
  const atEnqueue = (event: HostEvent) =>
    childEvent("session.inbox.enqueued", child)(event) && event.data?.item?.payload?.metadata?.shellID === shellID
  const atStart = childEvent("session.execution.started", child)
  const atEnd = childEvent("session.execution.succeeded", child)
  const seen: HostEvent[] = [failure]
  let notice = Option.none<string>()
  const success = yield* observeUntil(events, "finished shell continuation", (event) => {
    if (atEnqueue(event)) notice = Option.fromUndefinedOr(event.data?.inboxID)
    const delivered = childEvent("session.inbox.delivered", child)(event) && Option.exists(notice, (id) => event.data?.inboxID === id)
    if (atExit(event) || atEnqueue(event) || atStart(event) || delivered || atEnd(event)) seen.push(event)
    return atEnd(event)
  }).pipe(Effect.timeout("10 seconds"))
  const resumed = yield* Effect.fromOption(Option.fromUndefinedOr(seen.find(atStart))).pipe(Effect.mapError(() => fault("missing shell resume")))
  const trace = seen.map((event) => ({ kind: event.type, id: event.id || "", seq: point(event), at: Number(event.created) }))
  yield* Console.log(`native shell trace ${encode(trace)}`)
  return { resumed, success, trace, seen }
})

const firstPeriod = Effect.fn("LifecycleFixture.firstPeriod")(function* (
  first: Embedded, base: string, gate: string, readModel: Effect.Effect<{ requests: number; content: string; script: string; tools: string }>,
) {
  const events = yield* eventStream(first)
  const { id: root } = yield* promised("root was not created", () => first.sessions.create({ location: { directory: base } }))
  const launch = yield* ask(first, root, fixtureCall("kernel", { code: `const h = await tools.subagent(${encode({ agent: "general", description: "Fixture child", prompt: denied })}); h.sessionID` }))
  const listed = yield* promised("child list failed", () => first.sessions.list({ parentID: root }))
  const { id: child } = yield* Option.match(Arr.head(listed.data), {
    onSome: Effect.succeed,
    onNone: () => Effect.flatMap(readModel, (model) =>
      Effect.fail(fault(`no child was launched; model: ${encode(model)}; scripted kernel output: ${takeAnswer(launch, "kernel")}`))),
  })
  const shell = yield* nextEvent(events, "child shell.created", (event) => event.type === "shell.created" && event.data?.info?.metadata.sessionID === child)
  const failed = yield* nextEvent(events, "child session.execution.failed", childEvent("session.execution.failed", child))
  const failedInfo = yield* promised("failed child snapshot lost", () => first.sessions.get({ sessionID: child }))
  const before = yield* ask(first, root, fixtureCall("subagents", { action: "get", sessionID: child }))
  const row = yield* realRows(first, base, root, child, before, Option.fromUndefinedOr(shell.data?.info), Number(failed.created) + 1)
  const continued = yield* ask(first, root, handle(child))
  yield* releaseShell(gate)
  const { resumed, success, trace, seen } = yield* shellTrace(events, child, shell, failed)
  const shellInfo = yield* Effect.fromOption(Option.fromUndefinedOr(shell.data?.info)).pipe(Effect.mapError(() => fault("no native shell info")))
  const { replayRows } = yield* solidFixture
  const traceRows = replayRows(failedInfo, root, shellInfo, [shell, ...seen.slice(0, -1)])
  const rebuilt = yield* ask(first, root, handle(child))
  const notices = rebuilt.map(message).flatMap((item) => {
    if (item?.type === "notice" && item.childID === child) return [item.state]
    return []
  })
  const info = yield* promised("child snapshot lost", () => first.sessions.get({ sessionID: child }))
  const finalRow = yield* realRows(first, base, root, child, rebuilt, Option.none(), Number(success.created) + 1)
  return {
    root, child, before: takeAnswer(before, "subagents"), continued: takeAnswer(continued, "kernel"), row: row.row, shown: row.visible,
    finalRow: finalRow.row, after: takeAnswer(rebuilt, "kernel"), resumed: eventPoint(resumed), success: eventPoint(success), trace, traceRows,
    order: [point(failed), point(resumed), point(success)], notices, hostOutcome: info.outcome || "",
    snapshotUsesStart: info.time?.busy === resumed.created,
    snapshotCoversTerminal: Number(info.time?.idle) >= Number(success.created),
  }
})

const realRows = Effect.fn("LifecycleFixture.realRows")(function* (
  first: Embedded, base: string, root: string, child: string, before: ReadonlyArray<Schema.Json>, shell: Option.Option<ShellInfo>, now: number,
) {
  const current = yield* promised("child snapshot lost", () => first.sessions.get({ sessionID: child }))
  const parent = yield* promised("parent snapshot lost", () => first.sessions.get({ sessionID: root }))
  const transcript = yield* promised("child transcript lost", () => first.sessions.context({ sessionID: child }))
  const pending = yield* promised("child inbox lost", () => first.sessions.inbox.list({ sessionID: child }))
  const choose = (id: string) => {
    if (id === root) return { info: parent, messages: before }
    return { info: current, messages: transcript }
  }
  const { liveEvents, mountRows } = yield* solidFixture
  const { listen, listeners } = liveEvents(first.events)
  const data: Reads = {
    session: {
      get: (id) => choose(id).info,
      root: () => root, family: () => [root, child], status: () => "idle",
      permission: { list: () => [] }, form: { list: () => [] },
      pending: { list: (id) => {
        if (id === child) return pending
        return []
      } },
      message: { list: (id) => choose(id).messages },
    },
    shell: { list: () => Option.toArray(shell) },
    listen,
  }
  const readMount = Effect.acquireUseRelease(Effect.sync(() => mountRows(data, base, root, child, first)), (view) =>
    view.ready.pipe(
      Effect.timeout("3 seconds"),
      Effect.map(() => view.rows()),
    ), (view) => Effect.sync(view.close).pipe(Effect.andThen(Effect.yieldNow)),
  )
  const row = yield* readMount
  const afterClose = listeners()
  const reopened = yield* readMount
  const shown = (rows: typeof row, at: number) => visible(rows, at).map(({ state, update }) => ({ state, update }))
  const remount = {
    same: encode(row) === encode(reopened),
    beforeLinger: shown(row, now + 30_001), afterLinger: shown(reopened, now + 30_001),
    afterClose, afterSecondClose: listeners(),
  }
  return {
    row: Option.getOrElse(Option.map(Arr.head(row), (value) => value.state), () => ""),
    ended: Option.getOrElse(Option.flatMap(Arr.head(row), (value) => Option.fromUndefinedOr(value.ended)), () => -1),
    visible: visible(row, now).map((value) => value.state),
    remount,
  }
})

const fixture = Effect.gen(function* () {
  const base = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_HOME")
  const fork = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_FORK")
  const cmd = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_PLUGIN")
  const path = yield* Path.Path
  const gate = path.join(base, "release")
  yield* command("mkfifo", [gate])
  const model = yield* modelFor(gate)
  const now = yield* Clock.currentTimeMillis
  const opensAt = now + 3_600_000
  const plugins = pluginConfig(cmd, base, path.join, opensAt)
  const acquire = host(model.baseURL, base, fork, plugins)
  const first = yield* Effect.scoped(Effect.flatMap(acquire, (opened) => Effect.gen(function* () {
    const observed = yield* firstPeriod(opened, base, gate, model.read)
    const latch = yield* heldChild(opened, base, "Fixture distant hold")
    const clamp = yield* timedHold(opened, base)
    const earlier = yield* earlierFailure(opened, base, gate, model.affirmExit)
    const retry = yield* observedRetry(opened, base, model.finishRetry)
    const silent = yield* silentExit(opened, base, model.failSilent)
    return { ...observed, latch, clamp, earlier, retry, silent, opensAt }
  })))
  // Commit a later busy period while the production observer is absent. A
  // same-outcome snapshot after reopen must not authenticate the saved end.
  // Keep the agents supplied by Orchestrate; only Kernel's observer is absent.
  const unobserved = host(model.baseURL, base, fork, plugins.filter(({ package: name }) => name !== path.join(cmd, "kernel")))
  yield* Effect.scoped(Effect.flatMap(unobserved, (opened) => Effect.gen(function* () {
    const events = yield* eventStream(opened)
    yield* ask(opened, first.child, "Finish one new fixture period during the observation gap.")
    const end = yield* nextEvent(events, "unobserved execution terminal", (event) =>
      event.data?.sessionID === first.child && ["session.execution.failed", "session.execution.succeeded"].includes(event.type),
    )
    if (end.type !== "session.execution.succeeded") return yield* fault(`unobserved child did not succeed: ${end.data?.error?.type}`)
  })))
  const reopened = yield* Effect.scoped(Effect.flatMap(acquire, (opened) => Effect.gen(function* () {
    const replay = opened.experimental.session.log({ sessionID: first.child, follow: false })[Symbol.asyncIterator]()
    const periods: number[] = []
    yield* nextEvent(replay, "log.synced", (event) => {
      if (childEvent("session.execution.succeeded", first.child)(event)) periods.push(point(event))
      return event.type === "log.synced"
    })
    const context = yield* ask(opened, first.root, handle(first.child))
    const { root, child, inboxID } = first.silent
    const retained = yield* ask(opened, root, handle(child))
    const retainedRows = yield* realRows(opened, base, root, child, retained, Option.none(), now + 1)
    yield* promised("native inbox cancellation failed", () => opened.sessions.inbox.cancel({ sessionID: child, inboxID }))
    const cancelled = yield* ask(opened, root, handle(child))
    return { replayed: periods, recovered: takeAnswer(context, "kernel"),
      retained: takeAnswer(retained, "kernel"), retainedRows: retainedRows.visible, cancelled: takeAnswer(cancelled, "kernel") }
  })))
  const seen = yield* model.read
  yield* Console.log(encode({ ...first, ...reopened, content: seen.content, filtered: seen.filtered }))
})

const Sequenced = Schema.Struct({ id: Schema.String, seq: Schema.Int, at: Schema.Number })
const RowDisplay = Schema.Array(Schema.Struct({ state: Schema.String, update: Schema.String }))
const Remount = Schema.Struct({
  same: Schema.Boolean, beforeLinger: RowDisplay, afterLinger: RowDisplay,
  afterClose: Schema.Int, afterSecondClose: Schema.Int,
})
const CutEvidence = Schema.Struct({
  order: Schema.String, live: RowDisplay, acrossFirst: RowDisplay, outstanding: RowDisplay, after: RowDisplay,
  old: Schema.Int, current: Schema.Int, accepted: Schema.Int,
})
const ReadLatch = Schema.Struct({ child: Schema.String, mark: Schema.String, launch: Schema.String, rebuilt: Schema.String, listed: Schema.String })
const report = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  child: Schema.String, filtered: Schema.Boolean, before: Schema.String, row: Schema.String, after: Schema.String,
  order: Schema.Array(Schema.Int), notices: Schema.Array(Schema.String), hostOutcome: Schema.String, recovered: Schema.String, content: Schema.String,
  snapshotUsesStart: Schema.Boolean, snapshotCoversTerminal: Schema.Boolean, replayed: Schema.Array(Schema.Int), finalRow: Schema.String,
  continued: Schema.String, resumed: Sequenced, success: Sequenced, shown: Schema.Array(Schema.String),
  trace: Schema.Array(Schema.Struct({ kind: Schema.String, ...Sequenced.fields })),
  traceRows: Schema.Array(Schema.String),
  latch: ReadLatch,
  clamp: Schema.Struct({ ...ReadLatch.fields, reheldMark: Schema.String, reheldAt: Schema.Number, afterRehold: Schema.String, listedAfterRehold: Schema.String }),
  earlier: Schema.Struct({ row: Schema.String, shown: Schema.Array(Schema.String), ended: Schema.Number, exit: Schema.Number, terminal: Sequenced, observation: Schema.String, remount: Remount }),
  retry: Schema.Struct({ child: Schema.String, read: Schema.String, attempt: Schema.Number, at: Schema.Number, error: Schema.String }),
  silent: Schema.Struct({
    child: Schema.String, shellID: Schema.String, exit: Schema.Struct({ id: Schema.String, at: Schema.Number }),
    observation: Schema.String, direct: Schema.String, pending: Schema.Number, rows: Schema.Array(Schema.String),
    killed: Schema.String,
    gap: Schema.String, gapRows: Schema.Array(Schema.String), admittedRemount: Remount, scheduled: Schema.Array(CutEvidence),
    suppressed: Schema.Struct({ row: Schema.String, visible: Schema.Array(Schema.String), remount: Remount }),
  }),
  opensAt: Schema.Number, retained: Schema.String, retainedRows: Schema.Array(Schema.String), cancelled: Schema.String,
})))
const successOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), child: Schema.String, revision: Schema.Int,
  started: Schema.optionalKey(Sequenced),
  phase: Schema.Struct({ _tag: Schema.Literal("Settled"), outcome: Schema.Literal("succeeded"), cause: Schema.Literal("Unknown"), terminal: Schema.optionalKey(Sequenced) }),
})))
const Times = { recheckAt: Schema.Number, opensAt: Schema.Number }
const PaceReport = Schema.Struct({ hold: Schema.Literal("pace"), at: Schema.Number, ...Times })
const decodeMark = Schema.decodeUnknownEffect(Schema.fromJsonString(PaceReport))
const decodeHeld = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), child: Schema.String, revision: Schema.optionalKey(Schema.Int),
  route: Schema.optionalKey(Schema.Json),
  phase: Schema.Struct({ _tag: Schema.Literal("Latched"), hold: Schema.Struct({ _tag: Schema.Literal("Pace") }), ...Times }),
})))
const lastLine = (text: string) => text.trim().split("\n").at(-1)
const verifyHold = Effect.fn("LifecycleFixture.verifyHold")(function* (latch: typeof ReadLatch.Type) {
  const mark = yield* decodeMark(latch.mark)
  const launched = yield* decodeHeld(lastLine(latch.launch))
  const rebuilt = yield* decodeHeld(lastLine(latch.rebuilt))
  for (const observation of [launched, rebuilt]) {
    expect(observation.child).toBe(latch.child)
    expect(observation.phase.recheckAt).toBe(mark.recheckAt)
    expect(observation.phase.opensAt).toBe(mark.opensAt)
    expect(observation).not.toHaveProperty("route")
  }
  expect(rebuilt.revision).toBeGreaterThan(0)
  const time = DateTime.formatIso(DateTime.makeUnsafe(mark.recheckAt))
  expect(latch.listed).toContain(`latched (pace; recheck ${time})`)
  return mark
})

const verifyLife = Effect.fn("LifecycleFixture.verifyLife")(function* (result: Effect.Success<ReturnType<typeof report>>) {
  const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
  const continued = yield* parse(lastLine(result.continued))
  expect(continued).toMatchObject({
    child: result.child,
    phase: Phase.cases.Continuing.make({ on: "Shell" }),
    diagnostic: Diagnostic.cases.StepError.make({ cause: "PolicyDenied" }),
  })
  expect(result.shown).toEqual(["waiting"])
  expect(result.traceRows).toEqual(["waiting", "undetermined", "waiting", "working", "working"])
  expect(result.earlier.exit <= result.earlier.terminal.at).toBe(true)
  expect(result.earlier.row).toBe("failed")
  expect(result.earlier.shown).toEqual(["failed"])
  expect(result.earlier.ended).toBe(result.earlier.terminal.at)
  expect(result.earlier.remount).toEqual({ same: true, beforeLinger: [], afterLinger: [], afterClose: 0, afterSecondClose: 0 })
  const failed = yield* parse(lastLine(result.earlier.observation))
  expect(failed).toHaveProperty("phase", Phase.cases.Settled.make({ outcome: "failed", cause: "PolicyDenied", terminal: result.earlier.terminal }))
  expect(result.retry.error).toBe("provider.rate-limit")
  const retry = yield* parse(lastLine(result.retry.read))
  expect(retry).toMatchObject({
    child: result.retry.child, phase: Phase.cases.Running.make({}),
    diagnostic: Diagnostic.cases.RetryScheduled.make({ cause: "Transient", attempt: result.retry.attempt, at: result.retry.at }),
  })
  const silent = yield* parse(lastLine(result.silent.observation))
  expect(silent).toMatchObject({
    child: result.silent.child,
    phase: Phase.cases.Unknown.make({ reason: Undetermined.make({ shellID: result.silent.shellID, exit: result.silent.exit }) }),
  })
  expect(result.silent.pending).toBe(0)
  expect(result.silent.killed).toContain(result.silent.shellID)
  expect(result.silent.direct).toContain("undetermined (background command ended")
  expect(result.silent.rows).toEqual(["waiting", "undetermined"])
  expect(result.silent.suppressed.visible).toEqual(["waiting"])
  const undetermined = [{ state: "waiting", update: expect.stringContaining("Undetermined:") }]
  expect(result.silent.suppressed.remount).toEqual({ same: true, beforeLinger: undetermined, afterLinger: undetermined, afterClose: 0, afterSecondClose: 0 })
  expect(result.silent.scheduled.map(({ order }) => order)).toEqual(["shell-first", "owner-first"])
  for (const cut of result.silent.scheduled) {
    for (const rows of [cut.live, cut.acrossFirst, cut.outstanding]) expect(rows.map(({ state }) => state)).toEqual(["waiting"])
    expect(cut.after).toEqual(undetermined)
    expect(cut.accepted === cut.current && cut.current > cut.old).toBe(true)
  }
  const gap = yield* parse(lastLine(result.silent.gap))
  expect(gap).toHaveProperty("phase", Phase.cases.Continuing.make({ on: "Wake" }))
  expect(result.silent.gapRows).toEqual(["waiting"])
  expect(result.silent.admittedRemount).toMatchObject({ same: true, afterClose: 0, afterSecondClose: 0 })
  const retained = yield* parse(lastLine(result.retained))
  expect(retained).toMatchObject({ phase: Phase.cases.Continuing.make({ on: "Wake" }), basis: "as-of-last-observation" })
  expect(result.retainedRows).toEqual(["waiting"])
  const cancelled = yield* parse(lastLine(result.cancelled))
  expect(cancelled).toMatchObject({ phase: { ...Phase.cases.Settled.make({ outcome: "failed", cause: "PolicyDenied" }) } })
})

if (import.meta.main && parentEnv.LIFECYCLE_FIXTURE_HOME) {
  BunRuntime.runMain(Effect.scoped(fixture).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })))))
} else {
  describe.skipIf(!forkRuns)("on the pinned fork with a local model", () => {
    it.scopedLive.layer(BunServices.layer)("a child with an ended step keeps its identity through shell wake and host restart", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fork = yield* Config.schema(Schema.String, "OPENCODE_DEV")
        const home = yield* Effect.acquireRelease(Effect.sync(() => scratch("settle-child-attempts-")), (dir) => Effect.sync(() => dir[Symbol.dispose]()))
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => owned(["bun", "--conditions=browser", path.resolve("tests/settle-child-attempts.test.ts")], {
            cwd: home.path,
            env: {
              PATH: parentEnv.PATH, HOME: home.path, XDG_CONFIG_HOME: path.join(home.path, "config"), XDG_DATA_HOME: path.join(home.path, "data"),
              XDG_STATE_HOME: path.join(home.path, "state"), XDG_CACHE_HOME: path.join(home.path, "cache"),
              LIFECYCLE_FIXTURE_HOME: home.path, LIFECYCLE_FIXTURE_FORK: path.resolve(fork), LIFECYCLE_FIXTURE_PLUGIN: path.resolve("cmd"),
            },
            stdout: "pipe", stderr: "pipe",
          })),
          (child) => Effect.suspend(() => {
            child.kill()
            const release = released(child.pid)
            if (release) return Effect.promise(() => release)
            return Effect.void
          }),
        )
        const text = (src: ReadableStream<Uint8Array>) => Stream.fromReadableStream({ evaluate: () => src, onError: () => fault("fixture log read failed") })
          .pipe(Stream.decodeText(), Stream.mkString)
        const [stdout, stderr, code] = yield* Effect.all(
          [text(child.stdout), text(child.stderr), Effect.promise(() => child.exited)],
          { concurrency: 3 },
        ).pipe(Effect.timeout("45 seconds"))
        expect({ code, stderr, stdout }).toMatchObject({ code: 0 })
        const result = yield* report(stdout.trim().split("\n").at(-1))
        yield* Console.log(`fixture wire: system content ${result.content}; notices ${result.notices.join(", ")}; sequence points ${result.order.join(", ")}; first row ${result.row}`)
        yield* Console.log(`native shell trace ${encode(result.trace)}`)
        for (const kind of ["shell.exited", "session.inbox.enqueued", "session.inbox.delivered", "session.execution.started", "session.execution.succeeded"]) {
          expect(result.trace.map((event) => event.kind)).toContain(kind)
        }
        expect(result.content).toBe("string")
        expect(result.filtered).toBe(true)
        expect(result.before).toContain(`${result.child} continuing (shell still running)`)
        expect(result.before).toContain("step ended in error (PolicyDenied)")
        expect(result.row).toBe("waiting")
        expect(result.order).toHaveLength(3)
        expect(result.order.every((seq) => seq >= 0)).toBe(true)
        expect(result.order).toEqual([...new Set(result.order)].sort((left, right) => left - right))
        expect(result.notices).toEqual(["error", "completed"])
        expect(result.hostOutcome).toBe("succeeded")
        expect(result.snapshotUsesStart).toBe(true)
        expect(result.snapshotCoversTerminal).toBe(true)
        expect(result.finalRow).toBe("done")
        const settled = yield* successOf(result.after)
        expect(settled.child).toBe(result.child)
        expect(settled.started).toEqual(result.resumed)
        expect(settled.phase.terminal).toEqual(result.success)
        expect(result.replayed).toHaveLength(2)
        expect(result.replayed[0]).toBe(result.order.at(-1))
        expect(Number(result.replayed[1])).toBeGreaterThan(Number(result.replayed[0]))
        const lines = result.recovered.split("\n")
        expect(lines[0]).toBe("[new kernel; restored h]")
        const recovered = yield* successOf(lines[1]).pipe(
          Effect.mapError(() => fault(`unexpected rebuilt handle reply: ${result.recovered}`)),
        )
        expect(recovered.child).toBe(result.child)
        expect(recovered.started).toBeUndefined()
        expect(recovered.phase.terminal).toBeUndefined()
        const nativeMark = yield* verifyHold(result.latch)
        expect(nativeMark.opensAt).toBe(result.opensAt)
        expect(nativeMark.recheckAt).toBeLessThan(nativeMark.opensAt)
        const clamped = yield* verifyHold(result.clamp)
        expect(clamped.recheckAt).toBe(clamped.at + 1_000)
        expect(clamped.recheckAt).toBeGreaterThan(clamped.opensAt)
        const reheld = yield* decodeMark(result.clamp.reheldMark)
        const observedRehold = yield* decodeHeld(lastLine(result.clamp.afterRehold))
        expect(observedRehold.child).toBe(result.clamp.child)
        expect(observedRehold.phase.recheckAt).toBe(result.clamp.reheldAt)
        expect(observedRehold.phase.recheckAt).toBe(reheld.recheckAt)
        expect(observedRehold.phase.opensAt).toBe(reheld.opensAt)
        expect(result.clamp.listedAfterRehold).toContain(`latched (pace; recheck ${DateTime.formatIso(DateTime.makeUnsafe(reheld.recheckAt))})`)
        expect(reheld.recheckAt).toBeGreaterThan(clamped.recheckAt)
        yield* verifyLife(result)
      }),
      55_000,
    )
  })
}

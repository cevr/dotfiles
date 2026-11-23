import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Config, Console, Effect, Layer, Option, Path, Predicate, Ref, Schema, Stream } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { Answer, chatEvents } from "../sim/verify-model.ts"
import { message, read, type SessionInfo, type ShellInfo } from "../mods/subagents/opencode/view.ts"
import { subagents } from "../mods/subagents/subagent-row.ts"
import { owned, released } from "./owned.ts"
import { forkRuns, parentEnv, scratch } from "./scratch.ts"

interface HostEvent {
  readonly type: string
  readonly created?: number
  readonly durable?: { readonly seq: number }
  readonly data?: { readonly sessionID?: string; readonly info?: ShellInfo }
}

interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string } }) => Promise<{ id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => PromiseLike<object>
    readonly list: (input: { parentID: string }) => Promise<{ data: ReadonlyArray<SessionInfo> }>
    readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
    readonly context: (input: { sessionID: string }) => Promise<ReadonlyArray<Schema.Json>>
  }
  readonly experimental: { readonly session: {
    readonly wait: (input: { sessionID: string }) => PromiseLike<object>
    readonly log: (input: { sessionID: string; follow: false }) => AsyncIterable<HostEvent>
  } }
  readonly events: { readonly subscribe: () => AsyncIterable<HostEvent> }
  readonly close: () => Promise<void>
}

const Sdk = Schema.declare((input): input is { readonly OpenCode: { create(options: Schema.JsonObject): Promise<Embedded> } } =>
  Predicate.isObject(input) && Predicate.isObject(input.OpenCode) && Predicate.isFunction(input.OpenCode.create),
)
class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", { message: Schema.String }) {}
const fault = (message: string) => new FixtureError({ message })
const promised = <A>(message: string, read: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => {
    if (Predicate.isError(error)) return fault(`${message}: ${error.message.slice(0, 400)}`)
    return fault(message)
  } })

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const denied = "SCRIPTED_CHILD_DENIAL"
const childPrompt = (text: string) => text.split("\n").includes(denied)

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
  const state = yield* Ref.make({ requests: 0, filtered: false, content: "", script: "not reached", tools: "" })
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
    const { id, filter } = yield* Ref.modify(state, (prev) => {
      const requests = prev.requests + 1
      const filter = !prev.filtered && !title && childPrompt(prompt) && shellAnswered
      const content = contentKind(system)
      const tools = Option.getOrElse(Option.fromUndefinedOr(body.tools), () => []).flatMap((tool) => Option.toArray(Option.fromUndefinedOr(tool.function?.name)))
        .filter((name) => ["kernel", "subagent", "subagents", "shell"].includes(name)).join(",")
      return [{ id: `fixture${requests}`, filter }, { requests, filtered: prev.filtered || filter, content, script: answer._tag, tools }]
    })
    let events = chatEvents(answer, "sim-model", id)
    if (filter) events = chatEvents(Answer.Text({ text: "" }), "sim-model", id).map((event) =>
      event.replace('"finish_reason":"stop"', '"finish_reason":"content_filter"'),
    )
    return HttpServerResponse.text(events.join(""), { contentType: "text/event-stream" })
  }).pipe(Effect.orDie))
  const server = yield* HttpServer.HttpServer
  return { baseURL: `${HttpServer.formatAddress(server.address)}/v1`, read: Ref.get(state) }
})

const contentKind = (system?: typeof Wire.Type.messages[number]) => {
  if (Predicate.isString(system?.content)) return "string"
  return "missing"
}
const VerifyCall = Schema.Struct({ tool: Schema.String, input: Schema.JsonObject })
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(VerifyCall))
const fixtureAnswer = (prompt: string, title: boolean, answered: boolean, gate: string) => {
  if (title) return Answer.Text({ text: "Fixture title" })
  if (childPrompt(prompt) && !answered)
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

const host = Effect.fn("LifecycleFixture.host")(function* (baseURL: string, base: string, fork: string, plugin: Option.Option<string>) {
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
        plugins: Option.toArray(plugin).map((name) => ({ package: name, options: { direct: ["subagents", "shell"] } })),
      }) },
    })),
    (instance) => Effect.promise(() => instance.close()),
  )
})

const childEvent = (name: string, child: string) => (event: HostEvent) => event.type === name && event.data?.sessionID === child
const point = (event: HostEvent) => Option.getOrElse(Option.fromUndefinedOr(event.durable?.seq), () => -1)
const handle = (child: string) => fixtureCall("kernel", { code: `JSON.stringify((await tools.subagent.handle(${encode(child)})).observation)` })
const nextEvent = (events: AsyncIterator<HostEvent>, name: string, accept: (event: HostEvent) => boolean) =>
  observeUntil(events, name, accept).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(fault(`missing fixture event: ${name}`)) }))

const firstPeriod = Effect.fn("LifecycleFixture.firstPeriod")(function* (
  first: Embedded, base: string, gate: string, readModel: Effect.Effect<{ requests: number; content: string; script: string; tools: string }>,
) {
  const events = first.events.subscribe()[Symbol.asyncIterator]()
  // The first event is the connection barrier, not a sleep or poll.
  yield* nextEvent(events, "server.connected", (event) => event.type === "server.connected")
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
  const before = yield* ask(first, root, fixtureCall("subagents", { action: "get", sessionID: child }))
  const row = yield* realRow(first, root, child, before, Option.fromUndefinedOr(shell.data?.info))
  yield* command("sh", ["-c", 'printf ready > "$1"', "fixture", gate]).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(fault("child shell never opened the FIFO")) }),
  )
  const resumed = yield* nextEvent(events, "child resumed", childEvent("session.execution.started", child))
  const success = yield* nextEvent(events, "child succeeded", childEvent("session.execution.succeeded", child))
  const rebuilt = yield* ask(first, root, handle(child))
  const notices = rebuilt.map(message).flatMap((item) => {
    if (item?.type === "notice" && item.childID === child) return [item.state]
    return []
  })
  const info = yield* promised("child snapshot lost", () => first.sessions.get({ sessionID: child }))
  const finalRow = yield* realRow(first, root, child, rebuilt, Option.none())
  return {
    root, child, before: takeAnswer(before, "subagents"), row, finalRow, after: takeAnswer(rebuilt, "kernel"),
    order: [point(failed), point(resumed), point(success)], notices, hostOutcome: info.outcome || "",
    snapshotUsesStart: info.time?.busy === resumed.created,
    snapshotCoversTerminal: Number(info.time?.idle) >= Number(success.created),
  }
})

const realRow = Effect.fn("LifecycleFixture.realRow")(function* (
  first: Embedded, root: string, child: string, before: ReadonlyArray<Schema.Json>, shell: Option.Option<ShellInfo>,
) {
  const current = yield* promised("child snapshot lost", () => first.sessions.get({ sessionID: child }))
  const parent = yield* promised("parent snapshot lost", () => first.sessions.get({ sessionID: root }))
  const transcript = yield* promised("child transcript lost", () => first.sessions.context({ sessionID: child }))
  const choose = (id: string) => {
    if (id === root) return { info: parent, messages: before }
    return { info: current, messages: transcript }
  }
  const row = subagents(read({
    session: {
      get: (id) => choose(id).info,
      root: () => root, family: () => [root, child], status: () => "idle",
      permission: { list: () => [] }, form: { list: () => [] },
      message: { list: (id) => choose(id).messages },
    },
    shell: { list: () => Option.toArray(shell) },
  }, root), root)
  return Option.getOrElse(Option.map(Arr.head(row), (value) => value.state), () => "")
})

const fixture = Effect.gen(function* () {
  const base = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_HOME")
  const fork = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_FORK")
  const plugin = yield* Config.schema(Schema.String, "LIFECYCLE_FIXTURE_PLUGIN")
  const path = yield* Path.Path
  const gate = path.join(base, "release")
  yield* command("mkfifo", [gate])
  const model = yield* modelFor(gate)
  const acquire = host(model.baseURL, base, fork, Option.some(plugin))
  const first = yield* Effect.scoped(Effect.flatMap(acquire, (opened) => firstPeriod(opened, base, gate, model.read)))
  // Commit a later busy period while the production observer is absent. A
  // same-outcome snapshot after reopen must not authenticate the saved end.
  const unobserved = host(model.baseURL, base, fork, Option.none())
  yield* Effect.scoped(Effect.flatMap(unobserved, (opened) =>
    ask(opened, first.child, "Finish one new fixture period during the observation gap."),
  ))
  const reopened = yield* Effect.scoped(Effect.flatMap(acquire, (opened) => Effect.gen(function* () {
    const replay = opened.experimental.session.log({ sessionID: first.child, follow: false })[Symbol.asyncIterator]()
    const periods: number[] = []
    yield* nextEvent(replay, "log.synced", (event) => {
      if (childEvent("session.execution.succeeded", first.child)(event)) periods.push(point(event))
      return event.type === "log.synced"
    })
    const context = yield* ask(opened, first.root, handle(first.child))
    return { replayed: periods, recovered: takeAnswer(context, "kernel") }
  })))
  const seen = yield* model.read
  yield* Console.log(encode({ ...first, ...reopened, content: seen.content, filtered: seen.filtered }))
})

const report = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  child: Schema.String, filtered: Schema.Boolean, before: Schema.String, row: Schema.String, after: Schema.String,
  order: Schema.Array(Schema.Int), notices: Schema.Array(Schema.String), hostOutcome: Schema.String, recovered: Schema.String, content: Schema.String,
  snapshotUsesStart: Schema.Boolean, snapshotCoversTerminal: Schema.Boolean, replayed: Schema.Array(Schema.Int), finalRow: Schema.String,
})))
const Sequenced = Schema.Struct({ id: Schema.String, seq: Schema.Int, at: Schema.Number })
const successOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), child: Schema.String, revision: Schema.Int,
  started: Schema.optionalKey(Sequenced),
  phase: Schema.Struct({ _tag: Schema.Literal("Settled"), outcome: Schema.Literal("succeeded"), terminal: Schema.optionalKey(Sequenced) }),
})))

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
          Effect.sync(() => owned(["bun", path.resolve("tests/settle-child-attempts.test.ts")], {
            cwd: home.path,
            env: {
              PATH: parentEnv.PATH, HOME: home.path, XDG_CONFIG_HOME: path.join(home.path, "config"), XDG_DATA_HOME: path.join(home.path, "data"),
              XDG_STATE_HOME: path.join(home.path, "state"), XDG_CACHE_HOME: path.join(home.path, "cache"),
              LIFECYCLE_FIXTURE_HOME: home.path, LIFECYCLE_FIXTURE_FORK: path.resolve(fork), LIFECYCLE_FIXTURE_PLUGIN: path.resolve("cmd/kernel"),
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
        expect(settled.started?.seq).toBe(result.order[1])
        expect(settled.phase.terminal?.seq).toBe(result.order[2])
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
      }),
      55_000,
    )
  })
}

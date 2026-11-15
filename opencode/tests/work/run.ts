// One work run in real OpenCode (the fork, embedded through its SDK, as tests/auto-title/run.ts runs it), on the
// scripted model (tests/work/sim.ts) on a loopback port, with cmd/work loaded from config as the owner would load
// it, on the real `work` binary. tests/work.test.ts starts it in a child process whose HOME and XDG dirs are a
// scratch dir, so work's registry is the run's own, with `WORK_E2E_BASE`, `WORK_E2E_FORK`, `WORK_E2E_PLUGIN`,
// `WORK_E2E_BIN`, `WORK_E2E_TASK` and, for a land, `WORK_E2E_WAKE`. The work dir is a base: a git repository with
// one commit pushed to a bare origin, `work.toml` in its `.git/info/exclude`, registered with `work init`, with a
// gate and an accept check. It writes what the session's tool calls said, the model's requests and what is on
// disk after the run to `<base>/result.json`. It imports nothing of the fork's at compile time.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Config, Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema, Stream } from "effect"
import { HttpServer } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitInit } from "../git-repo.ts"
import { type Call, model, Result, type Seen } from "./sim.ts"

class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string; readonly cause?: unknown }> {}
class NotYet extends Data.TaggedError("NotYet")<{}> {}

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A tool part of an assistant message, as much of it as the run reads. */
const ToolPart = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
    error: Schema.optional(Schema.Unknown),
  }),
})
const isToolPart = Schema.is(ToolPart)

/** A message of the session's context, as the SDK types it here: its parts are read by `ToolPart`. */
interface Message {
  readonly type: string
  readonly content?: ReadonlyArray<object>
}

/** The session's tool calls, in order: each one's name, status and what it said (its content's text and its error). */
const callsOf = (messages: ReadonlyArray<Message>): ReadonlyArray<Call> =>
  messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => Option.getOrElse(Option.fromUndefinedOr(message.content), () => []))
    .flatMap((part) => Option.toArray(Option.map(Option.liftPredicate(part, isToolPart), callOf)))

/** What one tool part said: its name, status, and its content's text and its error. */
const callOf = (part: typeof ToolPart.Type): Call => ({
  name: part.name,
  status: part.state.status,
  said: [
    ...Option.getOrElse(Option.fromUndefinedOr(part.state.content), () => []).map((item) => Option.getOrElse(Option.fromUndefinedOr(item.text), () => "")),
    ...Option.toArray(Option.map(Option.fromUndefinedOr(part.state.error), toJson)),
  ].join("\n"),
})

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** Runs `argv` in `cwd` with this process's environment and `env`; its output, or a RunFailed naming what it said. */
const sh = (cwd: string, argv: ReadonlyArray<string>, env: { readonly [name: string]: string } = {}) =>
  Effect.gen(function* () {
    const [command = "", ...args] = argv
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, env, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }))
    const [code, out, err] = yield* Effect.all([child.exitCode, text(child.stdout), text(child.stderr)], { concurrency: 3 })
    if (Number(code) !== 0) return yield* new RunFailed({ message: `${argv.join(" ")} failed (exit ${code}): ${err}${out}` })
    return out
  }).pipe(Effect.scoped)

const git = (cwd: string, ...args: ReadonlyArray<string>) => sh(cwd, ["git", "-c", "user.name=work", "-c", "user.email=work@example.com", "-c", "commit.gpgsign=false", ...args])

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { readonly location: { readonly directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { readonly sessionID: string; readonly text: string }) => Promise<object>
    readonly context: (input: { readonly sessionID: string }) => Promise<ReadonlyArray<Message>>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { readonly sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface CreateOptions {
  readonly events: { readonly persist: boolean }
  readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: CreateOptions) => Promise<Embedded> }
}
const loadSdk = (file: string): Promise<Partial<Sdk>> => import(file)
const isSdk = (value: Partial<Sdk>): value is Sdk => Predicate.isFunction(value.OpenCode?.create)

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* Config.String("WORK_E2E_BASE")
  const fork = yield* Config.String("WORK_E2E_FORK")
  const plugin = yield* Config.String("WORK_E2E_PLUGIN")
  const bin = yield* Config.String("WORK_E2E_BIN")
  const task = yield* Config.String("WORK_E2E_TASK")
  const wake = yield* Config.option(Config.String("WORK_E2E_WAKE"))
  const config = path.join(base, "config")
  yield* fs.makeDirectory(config, { recursive: true })
  yield* fs.makeDirectory(path.join(base, "code/work"), { recursive: true })

  // The base: one commit pushed to a bare origin, work.toml kept out of Git's view, registered with work.
  const work = yield* fs.realPath(path.join(base, "code/work"))
  const origin = path.join(base, "origin.git")
  // Made through gitInit, as every test repository is: no background gc or maintenance.
  yield* Effect.try({ try: () => gitInit(origin, ["-q", "--bare", "-b", "main"]), catch: (cause) => new RunFailed({ message: "git init of the origin failed", cause }) })
  yield* Effect.try({ try: () => gitInit(work, ["-q", "-b", "main"]), catch: (cause) => new RunFailed({ message: "git init of the base failed", cause }) })
  yield* fs.writeFileString(path.join(work, "README.md"), "work\n")
  yield* git(work, "add", "README.md")
  yield* git(work, "commit", "-q", "-m", "first")
  yield* git(work, "remote", "add", "origin", origin)
  yield* git(work, "push", "-q", "-u", "origin", "main")
  yield* fs.writeFileString(path.join(work, ".git/info/exclude"), "work.toml\n")
  yield* sh(work, [bin, "--json", "init"], { WORK_BASE: work })
  // The repository's checks for a land: a gate and a slower accept that reports the batch's base.
  yield* git(work, "config", "user.name", "work")
  yield* git(work, "config", "user.email", "work@example.com")
  yield* git(work, "config", "rift.gate", 'echo " 2 pass"')
  yield* git(work, "config", "rift.accept", 'sleep 1 && echo " 1 pass since $RIFT_LAND_BASE"')
  const workspaces = path.join(path.dirname(work), ".work", path.basename(work))
  const workspace = path.join(workspaces, "feat-x")
  const integration = path.join(workspaces, "integrate")

  const seen: Array<Seen> = []
  yield* HttpServer.serveEffect(model(workspace, seen))
  const server = yield* HttpServer.HttpServer
  const content = {
    model: "sim/sim-model",
    small_model: "sim/sim-model",
    providers: {
      sim: {
        name: "Sim",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${HttpServer.formatAddress(server.address)}/v1`, apiKey: "sim-key" },
        models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
      },
    },
    // On this machine's PATH there may be no workrift; the run names the work binary outright.
    plugins: [{ package: plugin, options: { workrift: false, work: bin } }],
  }

  const sdk: Partial<Sdk> = yield* Effect.tryPromise({
    try: () => loadSdk(path.join(fork, "packages/sdk/src/index.ts")),
    catch: (cause) => new RunFailed({ message: "the fork's SDK did not load", cause }),
  })
  if (!isSdk(sdk)) return yield* new RunFailed({ message: "the fork's SDK has no OpenCode.create" })
  const opencode = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => sdk.OpenCode.create({ events: { persist: true }, config: { directory: config, project: false, content: toJson(content) } }),
      catch: (cause) => new RunFailed({ message: "OpenCode did not start", cause }),
    }),
    (embedded) => Effect.promise(() => embedded.close()),
  )
  const call = <A>(what: string, request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: (cause) => new RunFailed({ message: what, cause }) })
  const session = yield* call("the session was not made", () => opencode.sessions.create({ location: { directory: work } }))
  const context = call("the session did not read", () => opencode.sessions.context({ sessionID: session.id }))
  const idle = call("the turn did not end", () => opencode.experimental.session.wait({ sessionID: session.id }))
  yield* call("the prompt was refused", () => opencode.sessions.prompt({ sessionID: session.id, text: task }))
  yield* idle
  // A land's accept check runs after the turn ends, then wakes the session: the run waits for it, up to a minute.
  yield* Option.match(wake, {
    onNone: () => Effect.void,
    onSome: (said) =>
      context.pipe(
        Effect.filterOrFail((messages) => toJson(messages).includes(said), () => new NotYet()),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
        Effect.catchTag("NotYet", () => Effect.void),
        Effect.andThen(idle),
      ),
  })
  const messages = yield* context
  const originMain = yield* sh(origin, ["git", "log", "-1", "--format=%s", "main"])
  const result: Result = {
    calls: callsOf(messages),
    transcript: toJson(messages),
    seen,
    source: work,
    workspace,
    integration,
    originMain: originMain.trim(),
    workspaceThere: yield* fs.exists(workspace),
    integrationThere: yield* fs.exists(integration),
  }
  yield* fs.writeFileString(path.join(base, "result.json"), Schema.encodeSync(Schema.fromJsonString(Result))(result))
})

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))))

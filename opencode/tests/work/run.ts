// One work run in real OpenCode (the fork, embedded through its SDK, as tests/auto-title/run.ts runs it), on the
// scripted model (tests/work/sim.ts) on a loopback port, with cmd/work and cmd/tool-names loaded from config as the
// owner would load them, on the real `work` binary. tests/work.test.ts starts it in a child process whose HOME and XDG dirs are a
// scratch dir, so work's registry is the run's own. The request names both plugins and the binary;
// bare mode lists cmd/work with no options, finding work on PATH. The work dir is a base:
// a git repository with one commit pushed to a bare origin, `work.toml` in its `.git/info/exclude`, registered with `work init`, with a
// gate and an accept check. It writes what the session's tool calls said, the model's requests and what is on
// disk after the run to `<base>/result.json`. It imports nothing of the fork's at compile time.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { argv } from "bun"
import { Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { HttpServer } from "effect/http"
import { externalInput, matchingInput, readScratchFileSync, scratchInput } from "../read-path.ts"
import { initScratchGit, scratchWorkInit, spawnScratchGitSync } from "../scratch-child.ts"
import { type Call, model, Result, type Seen } from "./sim.ts"
import { Request } from "./request.ts"

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

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ran = yield* Effect.sync(() => spawnScratchGitSync(cwd, args, {
      GIT_AUTHOR_NAME: "work", GIT_AUTHOR_EMAIL: "work@example.com",
      GIT_COMMITTER_NAME: "work", GIT_COMMITTER_EMAIL: "work@example.com",
    }))
    if (ran.exitCode !== 0) return yield* new RunFailed({ message: `git ${args.join(" ")} failed (exit ${ran.exitCode}): ${ran.stderr}${ran.stdout}` })
    return ran.stdout.toString()
  })

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
  readonly models: { readonly fetch: boolean }
  readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: CreateOptions) => Promise<Embedded> }
}
const loadSdk = (file: string): Promise<Partial<Sdk>> => import(externalInput(file))
const isSdk = (value: Partial<Sdk>): value is Sdk => Predicate.isFunction(value.OpenCode?.create)

/**
 * cmd/work as config lists it. Bare (`WORK_E2E_BARE`), as daily lists it: no options, so `work` is found on PATH and
 * `workrift` is whether it is there. Else the work binary named outright, and no workrift (this machine's PATH may lack it).
 */
const entryOf = (plugin: string, bin: string, bare: boolean) => {
  if (bare) return plugin
  return { package: plugin, options: { workrift: false, work: bin } }
}

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spec = yield* Schema.decodeUnknownEffect(Request)(readScratchFileSync(argv[2] || "", "utf8"))
  const base = scratchInput(spec.base)
  const bin = externalInput(spec.bin)
  const config = path.join(base, "config")
  yield* fs.makeDirectory(config, { recursive: true })
  yield* fs.makeDirectory(path.join(base, "code/work"), { recursive: true })

  // The base: one commit pushed to a bare origin, work.toml kept out of Git's view, registered with work.
  const work = yield* fs.realPath(scratchInput(path.join(base, "code/work")))
  const origin = path.join(base, "origin.git")
  yield* fs.makeDirectory(origin)
  // No background gc or maintenance.
  yield* Effect.try({ try: () => initScratchGit(origin, ["-q", "--bare", "-b", "main"]), catch: (cause) => new RunFailed({ message: "git init of the origin failed", cause }) })
  yield* Effect.try({ try: () => initScratchGit(work, ["-q", "-b", "main"]), catch: (cause) => new RunFailed({ message: "git init of the base failed", cause }) })
  yield* fs.writeFileString(path.join(work, "README.md"), "work\n")
  yield* git(work, "add", "README.md")
  yield* git(work, "commit", "-q", "-m", "first")
  yield* git(work, "remote", "add", "origin", origin)
  yield* git(work, "push", "-q", "-u", "origin", "main")
  yield* fs.writeFileString(path.join(work, ".git/info/exclude"), "work.toml\n")
  const initialized = scratchWorkInit(bin, work, path.join(base, "home"), base)
  if (initialized.exitCode !== 0) return yield* new RunFailed({
    message: `work --json init failed (exit ${initialized.exitCode}): ${initialized.stderr}${initialized.stdout}`,
  })
  // The repository's checks for a land: a gate and a slower accept that reports the batch's base and fails, since
  // only a failed accept check wakes the session (a green one says nothing).
  yield* git(work, "config", "user.name", "work")
  yield* git(work, "config", "user.email", "work@example.com")
  yield* git(work, "config", "rift.gate", 'echo " 2 pass"')
  yield* git(work, "config", "rift.accept", 'sleep 1 && echo " 1 fail since $RIFT_LAND_BASE" && exit 1')
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
    plugins: [entryOf(matchingInput("cmd/work"), bin, spec.bare), matchingInput("cmd/tool-names")],
  }

  const sdk: Partial<Sdk> = yield* Effect.tryPromise({
    try: () => loadSdk(path.join(spec.fork, "packages/sdk/src/index.ts")),
    catch: (cause) => new RunFailed({ message: "the fork's SDK did not load", cause }),
  })
  if (!isSdk(sdk)) return yield* new RunFailed({ message: "the fork's SDK has no OpenCode.create" })
  const opencode = yield* Effect.acquireRelease(
    Effect.tryPromise({
      // The bundled model catalog only, as tests/compaction-prefix/run.ts says why.
      try: () => sdk.OpenCode.create({ events: { persist: true }, models: { fetch: false }, config: { directory: config, project: false, content: toJson(content) } }),
      catch: (cause) => new RunFailed({ message: "OpenCode did not start", cause }),
    }),
    (embedded) => Effect.promise(() => embedded.close()),
  )
  const call = <A>(what: string, request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: (cause) => new RunFailed({ message: what, cause }) })
  const session = yield* call("the session was not made", () => opencode.sessions.create({ location: { directory: work } }))
  const context = call("the session did not read", () => opencode.sessions.context({ sessionID: session.id }))
  const idle = call("the turn did not end", () => opencode.experimental.session.wait({ sessionID: session.id }))
  yield* call("the prompt was refused", () => opencode.sessions.prompt({ sessionID: session.id, text: spec.task }))
  yield* idle
  // A land's accept check runs after the turn ends, then wakes the session: the run waits for it, up to a minute.
  yield* Option.match(Option.fromUndefinedOr(spec.wake), {
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
  const originMain = yield* git(origin, "log", "-1", "--format=%s", "main")
  const result: Result = {
    calls: callsOf(messages),
    transcript: toJson(messages),
    seen,
    source: work,
    workspace,
    integration,
    originMain: originMain.trim(),
    workspaceThere: yield* fs.exists(scratchInput(workspace)),
    integrationThere: yield* fs.exists(scratchInput(integration)),
  }
  yield* fs.writeFileString(path.join(base, "result.json"), Schema.encodeSync(Schema.fromJsonString(Result))(result))
})

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))))

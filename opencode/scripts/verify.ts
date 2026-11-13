// The verify-opencode skill's helpers (`.claude/skills/verify-opencode/SKILL.md`), one Effect CLI behind
// `bun run verify:<command>`, each printing one JSON result (`{ "ok": true, … }`, or `{ "ok": false, "error": … }`
// and exit 1):
//
//   verify:seed <dir> [--plugins a,b]      a scratch root for a real OpenCode: work repo, home, config, secret
//   verify:launch --root <dir> --port <p>  the fork's server on the verify model; prints a ready line, runs
//                                          until stopped, and stops the server with it
//   verify:tui --root <dir>                the fork's TUI against that server, in this terminal (a pilotty session)
//   verify:doctor [--root <dir>]           read-only: is the world, or this launched server, worth driving
//   verify:drive [--feature id]… [--changed <base>] [--all] [--scenario <file>]… [--real] [--swarm-ms N]
//                                          runs the map's world suites (fixed seeds, then fresh ones), the
//                                          verifier's own world scenarios, and with --real the real checks
//   verify:stop --root <dir>               stops a launch by its recorded PID
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { randomBytes } from "node:crypto"
import { cpus, loadavg } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Array as Arr, Clock, Config, Console, Data, Duration, Effect, FileSystem, Match, Option, Predicate, Record as Rec, Schedule, Schema, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { cliConfig, DEFAULT_FORK, forkLaunch, pluginPaths, runEnv, runPaths, SIM_PROVIDER, simProvider } from "../testbeds/gamut/gamut.ts"
import { type Feature, FEATURES_DIR, parseFeature, swarmFrom, touched, underOpencode } from "./verify-map.ts"
import { chatResponse } from "../sim/verify-model.ts"

/** opencode/: every path the helpers name is from here. */
const OPENCODE = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const CMD = join(OPENCODE, "cmd")
const THEME = join(OPENCODE, "themes/prime.json")
const MODEL = `${SIM_PROVIDER}/sim-model`
/** How long a helper's own probe (git, ps, lsof) may run. */
const PROBE = "3 seconds"

/** A helper's step failed: which, and why, as the JSON result says it. */
class VerifyFailed extends Data.TaggedError("VerifyFailed")<{ readonly step: string; readonly message: string }> {}

const messageOf = (cause: unknown): string =>
  Match.value(cause).pipe(
    Match.when(Predicate.isError, (error) => error.message),
    Match.orElse((other) => String(other)),
  )

const failed = (step: string) => (cause: unknown) => new VerifyFailed({ step, message: messageOf(cause) })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const line = <A>(value: A): string => `${encodeJson(value)}\n`

// ── The scratch root ──

/** What `verify:seed` records in `<root>/verify.json` (owner-only): the heads it was made at, the plugins, the server's secret. */
const Seeded = Schema.Struct({
  dotfiles: Schema.String,
  fork: Schema.String,
  forkHead: Schema.String,
  plugins: Schema.Array(Schema.String),
  password: Schema.String,
})
type Seeded = typeof Seeded.Type

/** What `verify:launch` records in `<root>/launch.json` while it runs. */
const Launched = Schema.Struct({
  launchPid: Schema.Int,
  serverPid: Schema.Int,
  port: Schema.Int,
  modelPort: Schema.Int,
  dotfiles: Schema.String,
  forkHead: Schema.String,
})
type Launched = typeof Launched.Type

const SeededJson = Schema.fromJsonString(Seeded)
const LaunchedJson = Schema.fromJsonString(Launched)
const AnyJson = Schema.fromJsonString(Schema.Unknown)

/** A plugin's config entry: its package directory, with options when it takes some. */
interface Entry {
  readonly package: string
  readonly options: { readonly [key: string]: string }
}

const plain = (name: string) => (_home: string): Entry => ({ package: join(CMD, name), options: {} })

/** Each plugin a scratch server may load, as its config entry under the run's home. */
const PLUGINS = {
  orchestrate: plain("orchestrate"),
  status: (home: string): Entry => ({
    package: join(CMD, "status"),
    options: { log: join(home, ".cache/orchestrate/opencode-agents.jsonl"), statusScript: resolve(OPENCODE, "../skills/orchestrate/scripts/status.ts") },
  }),
  queue: (home: string): Entry => ({ package: join(CMD, "queue"), options: { dir: join(home, ".local/state/opencode-queue") } }),
  wake: (_home: string): Entry => ({ package: join(CMD, "wake"), options: { backstop: "off" } }),
  guard: plain("guard"),
  mail: plain("mail"),
  questions: plain("questions"),
  escape: plain("escape"),
  "tool-names": plain("tool-names"),
  skills: plain("skills"),
  memory: plain("memory"),
  cache: plain("cache"),
  "idle-compact": plain("idle-compact"),
  git: plain("git"),
  kernel: plain("kernel"),
  stall: plain("stall"),
} satisfies Rec.ReadonlyRecord<string, (home: string) => Entry>

/** Plugins a scratch server never loads, and why. */
const REFUSED = {
  update: "it moves the dotfiles checkout and restarts the owner's service",
  rift: "it makes and trashes Rifts of real repositories",
  pool: "it needs the owner's Claude logins; drive it on the world",
  "anthropic-auth": "it needs the owner's Claude logins; drive it on the world",
} satisfies Rec.ReadonlyRecord<string, string>

const PLUGINS_BY_NAME = new Map(Object.entries(PLUGINS))
const REFUSED_BY_NAME = new Map(Object.entries(REFUSED))

/** The plugins a scratch server loads when `--plugins` names none. */
export const DEFAULT_PLUGINS = ["orchestrate", "status", "queue", "wake", "guard", "mail", "questions", "escape", "tool-names", "skills"]

/** The plugin names a seed takes: each known and allowed, else the step fails naming it. */
const pluginsOf = (names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) =>
    Option.match(Option.fromNullishOr(REFUSED_BY_NAME.get(name)), {
      onSome: (why) => Effect.fail(new VerifyFailed({ step: "plugins", message: `${name}: ${why}` })),
      onNone: () =>
        Option.match(Option.fromNullishOr(PLUGINS_BY_NAME.get(name)), {
          onSome: () => Effect.succeed(name),
          onNone: () => Effect.fail(new VerifyFailed({ step: "plugins", message: `${name}: no such plugin; known: ${Rec.keys(PLUGINS).join(", ")}` })),
        }),
    }),
  )

/** A config entry as OpenCode reads it: the bare path when it takes no options. */
const entryOf = (entry: Entry) => Match.value(Rec.isEmptyRecord(entry.options)).pipe(Match.when(true, () => entry.package), Match.orElse(() => entry))

/** The run's `opencode.json`: the verify model in every agent, its provider on `modelPort`, the plugins. */
const projectConfig = (plugins: ReadonlyArray<string>, home: string, modelPort: number) => {
  const model = { model: MODEL }
  const agents = Object.fromEntries(
    ["build", "plan", "compaction", "general", "explore", "worker", "implementor", "planner", "verifier", "title", "summary"].map((name) => [name, model]),
  )
  return {
    model: MODEL,
    plugins: Arr.getSomes(plugins.map((name) => Option.map(Option.fromNullishOr(PLUGINS_BY_NAME.get(name)), (entry) => entryOf(entry(home))))),
    providers: { [SIM_PROVIDER]: simProvider(modelPort) },
    agents,
  }
}

/** The fork the helpers run: OPENCODE_DEV, else the prime-look Rift. */
const forkDir = Config.String("OPENCODE_DEV").pipe(
  Config.withDefault(DEFAULT_FORK),
  Config.map((dir) => resolve(dir)),
)

/** How the helpers start the fork: Bun on its CLI entry, with the TUI's preload. */
const launchOf = (fork: string) => forkLaunch(fork, process.execPath)

// ── Processes ──

/** A command's whole output, trimmed; fails naming the step. */
const output = Effect.fn("verify.output")(function* (step: string, command: string, args: ReadonlyArray<string>, cwd: string = OPENCODE) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const said = yield* spawner.string(ChildProcess.make(command, args, { cwd, stdin: "ignore", forceKillAfter: PROBE })).pipe(Effect.mapError(failed(step)))
  return said.trim()
})

/** A checkout's HEAD. */
const headOf = (dir: string) => output("head", "git", ["-C", dir, "rev-parse", "HEAD"])

/** The heads under test: this checkout's and the fork's. */
const heads = Effect.fn("verify.heads")(function* () {
  const fork = yield* forkDir.pipe(Effect.mapError(failed("fork")))
  const [dotfiles, forkHead] = yield* Effect.all([headOf(OPENCODE), headOf(fork)], { concurrency: 2 })
  return { dotfiles, forkHead, fork }
})

/** Prints a helper's JSON result. */
const print = <A>(result: A) => Console.log(encodeJson(result))

/** A result already printed as red (`ok: false`) exits 1 with no second line. */
const exitRed = (red: boolean) => Effect.when(Effect.sync(() => void (process.exitCode = 1)), Effect.succeed(red))

// ── seed ──

/** The scratch project: a git repository with a little text in it, the Prime theme, an identity for commits. */
const writeProject = Effect.fn("verify.writeProject")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = runPaths(root)
  yield* Effect.forEach([paths.work, paths.home, paths.config, paths.data, join(paths.work, ".opencode/themes")], (dir) => fs.makeDirectory(dir, { recursive: true }), { discard: true })
  yield* fs.writeFileString(join(paths.work, "AGENTS.md"), "# Verify scratch\n\nA scratch project for verify-opencode drives. Nothing here is real.\n")
  yield* fs.writeFileString(join(paths.work, "notes.txt"), "one\ntwo\nthree\n")
  yield* fs.copyFile(THEME, join(paths.work, ".opencode/themes/prime.json"))
  yield* fs.writeFileString(join(paths.home, ".gitconfig"), "[user]\n\tname = verify\n\temail = verify@local\n")
  yield* fs.writeFileString(join(paths.config, "cli.json"), line(cliConfig([...pluginPaths(CMD), "-opencode.btw"])))
  yield* output("seed", "git", ["init", "-q"], paths.work)
  yield* output("seed", "git", ["add", "-A"], paths.work)
  yield* output("seed", "git", ["-c", "user.name=verify", "-c", "user.email=verify@local", "commit", "-q", "-m", "verify: scratch project"], paths.work)
  return paths
})

const seed = Command.make(
  "seed",
  {
    dir: Argument.String("dir").pipe(Argument.withDescription("The scratch root to make (empty or absent)")),
    plugins: Flag.String("plugins").pipe(Flag.withDescription("Comma-separated server plugins"), Flag.withDefault(DEFAULT_PLUGINS.join(","))),
  },
  Effect.fn("verify.seed")(function* (input) {
    const fs = yield* FileSystem.FileSystem
    const root = resolve(input.dir)
    const plugins = yield* pluginsOf(input.plugins.split(",").map((name) => name.trim()).filter((name) => name !== ""))
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))
    if (entries.length > 0) return yield* new VerifyFailed({ step: "seed", message: `${root} is not empty: seed a fresh scratch root` })
    const paths = yield* writeProject(root)
    const { dotfiles, forkHead, fork } = yield* heads()
    const record: Seeded = { dotfiles, fork, forkHead, plugins, password: randomBytes(24).toString("base64url") }
    yield* fs.writeFileString(join(root, "verify.json"), `${Schema.encodeSync(SeededJson)(record)}\n`, { mode: 0o600 })
    yield* print({ ok: true, root, work: paths.work, plugins, dotfiles, forkHead, next: `bun run verify:launch --root ${root} --port <port>` })
  }),
).pipe(Command.withDescription("Make a scratch root for a real OpenCode drive"))

const readSeeded = Effect.fn("verify.readSeeded")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(join(root, "verify.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SeededJson)), Effect.mapError(failed("seed")))
})

const readLaunched = Effect.fn("verify.readLaunched")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(join(root, "launch.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LaunchedJson)), Effect.mapError(failed("launched")))
})

// ── launch ──

/** The verify model's answer to one HTTP request: a streamed chat completion, or 404. */
const modelResponse = async (request: Request, served: { count: number }): Promise<Response> => {
  const url = new URL(request.url)
  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
  const body = await request.text()
  served.count += 1
  const events = chatResponse(body, `verify${served.count}`)
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

/** The verify model on a free loopback port for the launch's lifetime: its port. */
const modelServer = Effect.acquireRelease(
  Effect.sync(() => {
    const served = { count: 0 }
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => modelResponse(request, served) })
  }),
  (server) => Effect.sync(() => server.stop(true)),
).pipe(Effect.map((server) => Option.getOrElse(Option.fromNullishOr(server.port), () => 0)))

/** The server's info route answers with the run's secret: ready. */
const answers = (port: number, password: string) =>
  Effect.tryPromise({
    try: () => fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` }, signal: AbortSignal.timeout(2_000) }),
    catch: failed("answers"),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new VerifyFailed({ step: "answers", message: `GET /api/info answered ${response.status}` }),
    ),
    Effect.map((response) => response.status),
  )

/** The server's process, its output into `log`, stopped (its group, then SIGKILL after 3 s) when the scope closes. */
const startServer = Effect.fn("verify.startServer")(function* (root: string, seeded: Seeded, port: number) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const paths = runPaths(root)
  const launch = launchOf(seeded.fork)
  const env = { ...runEnv(process.env, paths, launch, true), OPENCODE_SERVER_PASSWORD: seeded.password }
  const [bin, ...base] = launch.base
  const command = ChildProcess.make(bin, [...base, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: paths.work, env, extendEnv: false, stdin: "ignore", forceKillAfter: "3 seconds" })
  const child = yield* spawner.spawn(command).pipe(Effect.mapError(failed("server")))
  yield* child.all.pipe(Stream.run(fs.sink(join(root, "server.log"))), Effect.ignoreCause({ log: true }), Effect.forkScoped)
  return child
})

/** Waits until the server answers, every 250 ms within `seconds`. */
const ready = (port: number, password: string, seconds: number, root: string) =>
  answers(port, password).pipe(
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: seconds * 4 }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () => Effect.fail(new VerifyFailed({ step: "ready", message: `no answer on ${port} within ${seconds} s: see ${root}/server.log` })),
    }),
  )

const launch = Command.make(
  "launch",
  {
    root: Flag.String("root").pipe(Flag.withDescription("The scratch root verify:seed made")),
    port: Flag.Int("port").pipe(Flag.withDescription("The server's loopback port (never the owner's service port)")),
    timeout: Flag.Int("timeout").pipe(Flag.withDescription("Seconds the server has to answer"), Flag.withDefault(90)),
  },
  Effect.fn(
    "verify.launch",
  )(function* (input) {
    const fs = yield* FileSystem.FileSystem
    const root = resolve(input.root)
    const seeded = yield* readSeeded(root)
    if (yield* fs.exists(join(root, "launch.json"))) return yield* new VerifyFailed({ step: "launch", message: `${root} is launched already: verify:stop it first` })
    const modelPort = yield* modelServer
    const paths = runPaths(root)
    yield* fs.writeFileString(join(paths.work, "opencode.json"), line(projectConfig(seeded.plugins, paths.home, modelPort)))
    const child = yield* startServer(root, seeded, input.port)
    yield* ready(input.port, seeded.password, input.timeout, root)
    const record: Launched = { launchPid: process.pid, serverPid: child.pid, port: input.port, modelPort, dotfiles: seeded.dotfiles, forkHead: seeded.forkHead }
    yield* Effect.acquireRelease(fs.writeFileString(join(root, "launch.json"), `${Schema.encodeSync(LaunchedJson)(record)}\n`), () => fs.remove(join(root, "launch.json")).pipe(Effect.ignore))
    yield* print({ ok: true, ready: true, url: `http://127.0.0.1:${input.port}`, ...record, log: join(root, "server.log"), tui: `bun run verify:tui --root ${root}`, stop: `bun run verify:stop --root ${root}` })
    const code = yield* child.exitCode.pipe(Effect.mapError(failed("server")))
    return yield* new VerifyFailed({ step: "server", message: `the server exited ${code}: see ${root}/server.log` })
  }, Effect.scoped),
).pipe(Command.withDescription("Start the fork's server on the verify model; runs until verify:stop"))

// ── tui ──

const tui = Command.make(
  "tui",
  { root: Flag.String("root").pipe(Flag.withDescription("A launched scratch root")) },
  Effect.fn("verify.tui")(function* (input) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = resolve(input.root)
    const seeded = yield* readSeeded(root)
    const launched = yield* readLaunched(root)
    const term = yield* Config.String("TERM").pipe(Config.withDefault("xterm-256color"), Effect.mapError(failed("tui")))
    const paths = runPaths(root)
    const launch = launchOf(seeded.fork)
    const env = { ...runEnv(process.env, paths, launch, true), TERM: term, OPENCODE_PASSWORD: seeded.password }
    const [bin, ...base] = launch.base
    const command = ChildProcess.make(bin, [...base, "--server", `http://127.0.0.1:${launched.port}`, "--auto", paths.work], {
      cwd: paths.work,
      env,
      extendEnv: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      forceKillAfter: "3 seconds",
    })
    const child = yield* spawner.spawn(command).pipe(Effect.mapError(failed("tui")))
    const code = yield* child.exitCode.pipe(Effect.mapError(failed("tui")))
    yield* print({ ok: code === 0, tui: "exited", code })
  }, Effect.scoped),
).pipe(Command.withDescription("Open the fork's TUI on a launched server (run it inside a pilotty session)"))

// ── doctor ──

/** One doctor check's outcome. */
interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const check = <E, R>(name: string, body: Effect.Effect<string, E, R>) =>
  body.pipe(
    Effect.map((detail): Check => ({ name, ok: true, detail })),
    Effect.catch((error) => Effect.succeed<Check>({ name, ok: false, detail: messageOf(error) })),
  )

const must = (ok: boolean, detail: string, otherwise: string) =>
  Match.value(ok).pipe(
    Match.when(true, () => Effect.succeed(detail)),
    Match.orElse(() => Effect.fail(new VerifyFailed({ step: "doctor", message: otherwise }))),
  )

/**
 * The load against the core count. It never fails a drive: past the cores a timing claims nothing (say so beside
 * it), and the world reads no wall time at all, so only a swarm box plays fewer seeds.
 */
const loadCheck = Effect.sync((): Check => {
  const [one = 0] = loadavg()
  const cores = cpus().length
  const claim = Match.value(one < cores).pipe(
    Match.when(true, () => "timings claim what they measure"),
    Match.orElse(() => "at or past the cores: timings claim nothing"),
  )
  return { name: "load", ok: true, detail: `1-min load ${one.toFixed(1)} on ${cores} cores: ${claim}` }
})

/** The world's checks: the fork is there and linked, so a world suite loads the plugins. */
const worldChecks = Effect.fn("verify.worldChecks")(function* () {
  const fs = yield* FileSystem.FileSystem
  const fork = yield* forkDir.pipe(Effect.mapError(failed("fork")))
  return yield* Effect.all(
    [
      check("fork", fs.exists(join(fork, "packages/plugin")).pipe(Effect.flatMap((ok) => must(ok, fork, `no fork at ${fork}: set OPENCODE_DEV`)))),
      check("linked", fs.exists(join(OPENCODE, "sim/node_modules/@opencode/plugin")).pipe(Effect.flatMap((ok) => must(ok, "sim/node_modules/@opencode/plugin", "the fork is not linked: run bun run link-fork")))),
      check("head", headOf(OPENCODE)),
      loadCheck,
    ],
    { concurrency: 4 },
  )
})

/** The listening holders of a port. */
const holdersOf = (port: number) =>
  output("port", "lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((text) => text.split("\n").filter((line) => line !== "")),
  )

/** Whether a process holds `port` in the group `pid` leads (the server's own process group). */
const holdsPort = Effect.fn("verify.holdsPort")(function* (port: number, pid: number) {
  const holders = yield* holdersOf(port)
  const groups = yield* Effect.forEach(holders, (holder) => output("port", "ps", ["-o", "pgid=", "-p", holder]), { concurrency: 4 })
  const named = holders.join(", ") || "nothing"
  return yield* must(holders.includes(String(pid)) || groups.includes(String(pid)), `held by ${named}`, `port ${port} is held by ${named}, not the recorded server ${pid}`)
})

/** The log lines that say a request or a plugin failed. */
const FAILURE = /level=error|\bERROR\b|Unhandled|failed to load plugin|plugin.*failed/i

const logCheck = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bad = (yield* fs.readFileString(join(root, "server.log"))).split("\n").filter((line) => FAILURE.test(line))
    const first = Option.getOrElse(Arr.head(bad), () => "").slice(0, 300)
    return yield* must(bad.length === 0, "no failure lines", `${bad.length} failure line(s), first: ${first}`)
  })

/** What the head check wants: the commit named, else the launched one. */
const headCheck = (now: string, launched: string, commit: Option.Option<string>) =>
  Option.match(commit, {
    onNone: () => must(now === launched, now, `HEAD ${now} is not the launched ${launched}: launch again`),
    onSome: (wanted) => must(now === launched && now.startsWith(wanted), now, `HEAD ${now} is not the launched ${launched} or the commit under test ${wanted}: launch again`),
  })

/** A launched root's checks, in the skill's order. */
const launchedChecks = Effect.fn("verify.launchedChecks")(function* (root: string, commit: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const seeded = yield* check("seed", readSeeded(root).pipe(Effect.as(`${root}/verify.json parses`)))
  const config = yield* check("config", fs.readFileString(join(root, "work/opencode.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AnyJson)), Effect.as("work/opencode.json parses")))
  const record = yield* readLaunched(root).pipe(Effect.option)
  if (Option.isNone(record)) return [seeded, config, { name: "launched", ok: false, detail: `no ${root}/launch.json: run verify:launch` }]
  const launched = record.value
  const secret = yield* readSeeded(root).pipe(
    Effect.map((each) => each.password),
    Effect.orElseSucceed(() => ""),
  )
  const now = yield* heads()
  return [
    seeded,
    config,
    yield* check("pid", holdsPort(launched.port, launched.serverPid)),
    yield* check("head", headCheck(now.dotfiles, launched.dotfiles, commit)),
    yield* check("fork", must(now.forkHead === launched.forkHead, now.forkHead, `the fork moved to ${now.forkHead} from ${launched.forkHead}: launch again`)),
    yield* check("answers", answers(launched.port, secret).pipe(Effect.map((status) => `GET /api/info ${status}`))),
    yield* check("log", logCheck(root)),
    { name: "audio", ok: true, detail: "n/a: no browser in either drive path" },
    yield* loadCheck,
  ]
})

const doctor = Command.make(
  "doctor",
  {
    root: Flag.String("root").pipe(Flag.withDescription("A launched scratch root; without it, the world's checks"), Flag.optional),
    commit: Flag.String("commit").pipe(Flag.withDescription("The commit under test (a prefix)"), Flag.optional),
  },
  Effect.fn("verify.doctor")(function* (input) {
    const checks: ReadonlyArray<Check> = yield* Option.match(input.root, { onNone: () => worldChecks(), onSome: (root) => launchedChecks(resolve(root), input.commit) })
    const first = Arr.findFirst(checks, (each) => !each.ok)
    const path = Option.match(input.root, { onNone: () => "world", onSome: () => "real" })
    yield* print({ ok: Option.isNone(first), path, failed: Option.getOrNull(Option.map(first, (each) => each.name)), checks })
    yield* exitRed(Option.isSome(first))
  }),
).pipe(Command.withDescription("Read-only: is the world, or a launched server, worth driving?"))

// ── drive ──

/** The feature map, every feature file but the index. */
const readMap = Effect.fn("verify.readMap")(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = join(OPENCODE, FEATURES_DIR)
  const files = (yield* fs.readDirectory(dir).pipe(Effect.mapError(failed("map")))).filter((file) => file.endsWith(".md") && file !== "README.md").sort()
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(join(dir, file)).pipe(
      Effect.map((text) => parseFeature(file, text)),
      Effect.mapError(failed("map")),
    ),
  )
})

/** The features the change since `base` touches. */
const changedSince = (map: ReadonlyArray<Feature>, base: string) =>
  output("changed", "git", ["-C", OPENCODE, "diff", "--name-only", `${base}...HEAD`]).pipe(Effect.map((text) => touched(map, Arr.getSomes(text.split("\n").map(underOpencode)))))

/** The features a drive takes: named, touched since `changed`, or every one. */
const chosen = Effect.fn("verify.chosen")(function* (map: ReadonlyArray<Feature>, named: ReadonlyArray<string>, changed: Option.Option<string>, all: boolean) {
  const unknown = named.filter((id) => !map.some((feature) => feature.id === id))
  if (unknown.length > 0) return yield* new VerifyFailed({ step: "features", message: `no feature ${unknown.join(", ")}; the map has ${map.map((feature) => feature.id).join(", ")}` })
  if (all) return map
  const byChange = yield* Option.match(changed, { onNone: () => Effect.succeed<ReadonlyArray<Feature>>([]), onSome: (base) => changedSince(map, base) })
  return map.filter((feature) => named.includes(feature.id) || byChange.includes(feature))
})

/** One run of a drive: what ran, its exit, its time, its log, the fresh seeds it passed (a swarm's; else 0). */
interface Run {
  readonly file: string
  readonly kind: "world" | "swarm" | "scenario" | "real"
  readonly exit: number
  readonly ms: number
  readonly log: string
  readonly seeds: number
}

/** Runs one command from opencode/, its output into `log`, to a Run. */
const runOne = Effect.fn("verify.runOne")(function* (file: string, kind: Run["kind"], args: readonly [string, ...string[]], env: { readonly [name: string]: string }, log: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const from = yield* Clock.currentTimeMillis
  const [bin, ...rest] = args
  const child = yield* spawner.spawn(ChildProcess.make(bin, rest, { cwd: OPENCODE, env, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" })).pipe(Effect.mapError(failed(kind)))
  const text = yield* child.all.pipe(Stream.decodeText(), Stream.mkString, Effect.mapError(failed(kind)))
  const exit = yield* child.exitCode.pipe(Effect.mapError(failed(kind)))
  yield* fs.writeFileString(log, text)
  const ms = (yield* Clock.currentTimeMillis) - from
  const seeds = text.split("\n").filter((line) => line.startsWith("sim-swarm ")).length
  return { file, kind, exit: Number(exit), ms, log, seeds } satisfies Run
}, Effect.scoped)

/** A file's log name in the evidence dir. */
const logName = (evidence: string, file: string, kind: string) => join(evidence, `${file.replaceAll("/", "__")}.${kind}.log`)

/** A world suite: its fixed seeds, then `swarmMs` of fresh seeds from the head's number. */
const worldRuns = Effect.fn("verify.worldRuns")(function* (file: string, kind: "world" | "scenario", evidence: string, first: number, swarmMs: number) {
  const fixed = yield* runOne(file, kind, ["bun", "test", "--parallel=1", file], {}, logName(evidence, file, kind))
  if (swarmMs <= 0) return [fixed]
  const swarm = yield* runOne(file, "swarm", ["bun", "test", "--parallel=1", file], { SIM_SWARM: String(first), SIM_SWARM_MS: String(swarmMs) }, logName(evidence, file, "swarm"))
  return [fixed, swarm]
})

/** A real check: an acceptance test through `bun test`, a scenario through opencode-drive with its frames in the evidence dir. */
const realRun = Effect.fn("verify.realRun")(function* (file: string, evidence: string) {
  const fork = yield* forkDir.pipe(Effect.mapError(failed("fork")))
  const out = join(evidence, basename(file, ".ts"))
  return yield* Match.value(file.startsWith("scenarios/")).pipe(
    Match.when(true, () => runOne(file, "real", ["bunx", "opencode-drive", "run", file], { SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"), OPENCODE_DEV: fork }, logName(evidence, file, "real"))),
    Match.orElse(() => runOne(file, "real", ["bun", "test", "--parallel=1", file], { OPENCODE_DEV: fork }, logName(evidence, file, "real"))),
  )
})

/** Every run a drive makes, one after another: the world suites, the verifier's scenarios, the real checks. */
const runsOf = Effect.fn("verify.runsOf")(function* (features: ReadonlyArray<Feature>, scenarios: ReadonlyArray<string>, real: boolean, evidence: string, first: number, swarmMs: number) {
  const suites = Arr.dedupe(features.flatMap((feature) => feature.world))
  const reals = Arr.dedupe(features.flatMap((feature) => Arr.filter(feature.real, () => real)))
  const world = yield* Effect.forEach(suites, (file) => worldRuns(file, "world", evidence, first, swarmMs))
  const own = yield* Effect.forEach(scenarios, (file) => worldRuns(file, "scenario", evidence, first, swarmMs))
  const checks = yield* Effect.forEach(reals, (file) => realRun(file, evidence))
  return [...world.flat(), ...own.flat(), ...checks]
})

const drive = Command.make(
  "drive",
  {
    feature: Flag.String("feature").pipe(Flag.withDescription("A feature id of the map (repeat for more)"), Flag.atLeast(0)),
    changed: Flag.String("changed").pipe(Flag.withDescription("Drive every feature the change since this base touches"), Flag.optional),
    all: Flag.Boolean("all").pipe(Flag.withDescription("Drive every feature of the map"), Flag.withDefault(false)),
    scenario: Flag.String("scenario").pipe(Flag.withDescription("A world scenario of your own, a *.sim.test.ts under opencode/ (repeat for more)"), Flag.atLeast(0)),
    real: Flag.Boolean("real").pipe(Flag.withDescription("Also run each feature's real checks (real OpenCode)"), Flag.withDefault(false)),
    swarmMs: Flag.Int("swarm-ms").pipe(Flag.withDescription("Wall ms of fresh seeds per suite after its fixed seeds; 0 for none"), Flag.withDefault(3_000)),
    evidence: Flag.String("evidence").pipe(Flag.withDescription("Where the logs go (default out/verify/<head>)"), Flag.optional),
  },
  Effect.fn("verify.drive")(function* (input) {
    const fs = yield* FileSystem.FileSystem
    const map = yield* readMap()
    const features = yield* chosen(map, input.feature, input.changed, input.all)
    if (features.length === 0 && input.scenario.length === 0) return yield* new VerifyFailed({ step: "features", message: "nothing to drive: name --feature, --changed <base>, --all or --scenario" })
    const head = yield* headOf(OPENCODE)
    const evidence = resolve(Option.getOrElse(input.evidence, () => join(OPENCODE, "out/verify", head.slice(0, 12))))
    yield* fs.makeDirectory(evidence, { recursive: true })
    const runs = yield* runsOf(features, input.scenario, input.real, evidence, swarmFrom(head), input.swarmMs)
    const red = runs.filter((run) => run.exit !== 0)
    const result = {
      ok: red.length === 0,
      head,
      features: features.map((feature) => feature.id),
      unreachable: features.filter((feature) => feature.world.length === 0).map((feature) => `${feature.id}: no world suite; drive it on real OpenCode (--real, or the feature file's pilotty steps)`),
      evidence,
      runs,
      red: red.map((run) => `${run.kind} ${run.file}: exit ${run.exit}, ${run.log}`),
    }
    yield* fs.writeFileString(join(evidence, "drive.json"), line(result))
    yield* print(result)
    yield* exitRed(red.length > 0)
  }),
).pipe(Command.withDescription("Drive the map's features on the world (and with --real, on real OpenCode)"))

// ── stop ──

/** Whether the process `pid` still runs this helper's launch of `root`. */
const isLaunch = (pid: number, root: string) =>
  output("stop", "ps", ["-o", "command=", "-p", String(pid)]).pipe(
    Effect.map((command) => command.includes("verify.ts") && command.includes("launch") && command.includes(root)),
    Effect.orElseSucceed(() => false),
  )

/** Waits until the launch `pid` is gone, every 250 ms within 15 s. */
const gone = (pid: number, root: string) =>
  isLaunch(pid, root).pipe(
    Effect.filterOrFail(
      (alive) => !alive,
      () => new VerifyFailed({ step: "stop", message: `pid ${pid} still runs` }),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 60 }),
  )

const stop = Command.make(
  "stop",
  { root: Flag.String("root").pipe(Flag.withDescription("A launched scratch root")) },
  Effect.fn("verify.stop")(function* (input) {
    const fs = yield* FileSystem.FileSystem
    const root = resolve(input.root)
    const record = yield* readLaunched(root).pipe(Effect.option)
    if (Option.isNone(record)) return yield* print({ ok: true, stopped: false, detail: `no ${root}/launch.json: nothing launched` })
    const launched = record.value
    if (!(yield* isLaunch(launched.launchPid, root))) {
      yield* fs.remove(join(root, "launch.json")).pipe(Effect.ignore)
      return yield* print({ ok: true, stopped: false, detail: `pid ${launched.launchPid} is no launch of ${root} any more; its record is removed` })
    }
    // The recorded launch is this root's helper (its command line names verify.ts, launch and the root): SIGTERM ends it,
    // and its scope stops the server's process group.
    process.kill(launched.launchPid, "SIGTERM")
    yield* gone(launched.launchPid, root)
    const held = yield* holdersOf(launched.port)
    yield* print({ ok: held.length === 0, stopped: true, launchPid: launched.launchPid, serverPid: launched.serverPid, port: launched.port, portFree: held.length === 0 })
    if (held.length > 0) return yield* new VerifyFailed({ step: "stop", message: `port ${launched.port} is still held by ${held.join(", ")}` })
  }),
).pipe(Command.withDescription("Stop a launch by its recorded PID"))

// ── main ──

const verify = Command.make("verify").pipe(
  Command.withDescription("The verify-opencode skill's helpers"),
  Command.withSubcommands([seed, launch, tui, doctor, drive, stop]),
)

const main = Command.run(verify, { version: "1.0.0" }).pipe(
  Effect.catchTag("VerifyFailed", (error) =>
    print({ ok: false, error: { _tag: error._tag, step: error.step, message: error.message } }).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 1)))),
  ),
  Effect.catch((error) => Console.error(encodeJson({ ok: false, error: messageOf(error) })).pipe(Effect.andThen(Effect.sync(() => void (process.exitCode = 2))))),
)

if (import.meta.main) main.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)

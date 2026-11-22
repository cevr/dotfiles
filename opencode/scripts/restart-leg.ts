// `bun scripts/restart-leg.ts --root <scratch root>`: the Linux leg of a background shell across an OpenCode service
// restart, on a host whose user processes a user systemd manages (the workbox). It runs the INSTALLED compiled build
// (by default the one `~/.local/share/opencode-prime/current.plugins` belongs to, read only: a clone of it runs) on a
// scratch service: its HOME, XDG dirs, TMPDIR, database and port all under `<root>/restart-leg-<id>/`, a scripted
// model on a loopback port (no provider call), and the installed tree's update plugin (`entries/server/update`) with
// every path of its options in the run dir, so the service places itself in `opencode-service-<pid>.scope` as the
// owner's does (mods/update/placement.ts). No other plugin loads: wake and job plugins would register OS jobs.
//
// Cases, in order, on one scratch service the run restarts:
//   a  `service restart` (the handoff an install runs): a running background shell survives, is listed running by
//      the new server, its scope still exists and holds it, it ends, and the session gets the end notice
//      (`<background-result kind="shell" … state="completed" …>`), woken by it.
//   b  systemd's view before and after each case: the scratch units, each one's state and cgroup, the shell's cgroup,
//      so the report says why the shell survived (or did not).
//   c  a signal stop (SIGTERM to the scratch service, then `service start`): the shell, and what the session gets.
//   d  systemd stopping the scope that holds the shell (`systemctl --user stop`), then a start if the service went
//      with it: the same report as c.
//   For c and d, `--expect no-wake` (upstream: the cancelled notice waits in the session's inbox for its next turn)
//   or `--expect wake` (the fork's restart wake: the session is woken once with it) says which one passes.
//
// Safety: the run refuses port 8240 and every port the live service registers or is configured on; it refuses a run
// dir outside the root; it names its own launcher scopes (`restart-leg-<id>-<step>.scope`) and refuses one that the
// user manager already lists, and a placed scratch scope the list held before the run. Cleanup signals only pids
// and stops only units it recorded, each only while its processes carry the run dir in their environment or command
// line; it removes the run dir by its exact path, checked on the line before; and it fails loudly (exit 3) when the
// live service's pid or scope, the installed tree's pointer, the launcher, or the live update log (with a line of
// this run) differ from the start.
//
// Usage: bun scripts/restart-leg.ts --root <dir> [--expect no-wake|wake] [--cases a,c,d] [--port N]
//          [--tree <share>/current.plugins] [--binary <path>] [--wait-ms N] [--settle-ms N] [--dry-run]
// Exit: 0 pass, 1 a case failed, 2 refused or a usage error, 3 the live service or install changed.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Cause, Clock, Config, Console, Data, Duration, Effect, Exit, FileSystem, Layer, Option, Predicate, Random, Redacted, Ref, Result, Schedule, Schema, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// ── Input ───────────────────────────────────────────────────────────────

/** The port no scratch service may take: the owner's service port on the workbox. */
export const NEVER_PORT = 8240
/** Every run dir's name starts with this, under the root. */
export const RUN_PREFIX = "restart-leg-"
export const CASES = ["a", "c", "d"] as const
export type Case = (typeof CASES)[number]
export type Expect = "no-wake" | "wake"

export interface Flags {
  readonly root: string
  readonly expect: string
  readonly cases: string
  readonly port: Option.Option<number>
  readonly tree: Option.Option<string>
  readonly binary: Option.Option<string>
  readonly waitMs: number
  readonly settleMs: number
  readonly dryRun: boolean
  readonly noSystemd: boolean
}

export interface Input {
  /** The scratch root, absolute, without a trailing slash. */
  readonly root: string
  /** The run dir, `<root>/restart-leg-<id>`. */
  readonly run: string
  readonly id: string
  readonly expect: Expect
  readonly cases: ReadonlyArray<Case>
  readonly port: Option.Option<number>
  /** The installed plugin tree (`<share>/current.plugins`), as given; resolved once at the start. */
  readonly tree: string
  readonly binary: Option.Option<string>
  readonly waitMs: number
  readonly settleMs: number
  readonly dryRun: boolean
  /** The Mac smoke: no launcher scopes, no placement, no systemd view; cases a and c only. Refused on Linux. */
  readonly noSystemd: boolean
}

const trimSlash = (path: string) => path.replace(/(.)\/+$/, "$1")

/** The flags as a run's input, or why they do not make one. `home` fills the tree's default; `id` names the run dir. */
export const inputOf = (flags: Flags, home: string, id: string): Result.Result<Input, string> => {
  const root = trimSlash(flags.root)
  const cases = flags.cases.split(",").map((each) => each.trim()).filter((each) => each !== "")
  const unknown = cases.filter((each) => !CASES.some((known) => known === each))
  if (!root.startsWith("/")) return Result.fail(`--root must be an absolute path, not ${flags.root}`)
  if (root === "/" || root.split("/").includes("..")) return Result.fail(`--root ${flags.root} is not a scratch directory`)
  if (flags.expect !== "no-wake" && flags.expect !== "wake") return Result.fail(`--expect is no-wake or wake, not ${flags.expect}`)
  if (cases.length === 0 || unknown.length > 0) return Result.fail(`--cases lists a, c and d (b is every case's systemd view), not ${flags.cases}`)
  if (!/^[\w.-]+$/.test(id)) return Result.fail(`the run id ${id} is not a file name`)
  if (flags.noSystemd && cases.includes("d")) return Result.fail("--no-systemd runs cases a and c only: d is systemd stopping a scope")
  if (flags.waitMs < 1_000 || flags.settleMs < 0) return Result.fail("--wait-ms is at least 1000 and --settle-ms at least 0")
  const portRefused = Option.flatMap(flags.port, (port) => portRefusal(port, []))
  if (Option.isSome(portRefused)) return Result.fail(portRefused.value)
  return Result.succeed({
    root,
    run: `${root}/${RUN_PREFIX}${id}`,
    id,
    expect: flags.expect,
    cases: CASES.filter((each) => cases.includes(each)),
    port: flags.port,
    tree: Option.getOrElse(flags.tree, () => `${home}/.local/share/opencode-prime/current.plugins`),
    binary: flags.binary,
    waitMs: flags.waitMs,
    settleMs: flags.settleMs,
    dryRun: flags.dryRun,
    noSystemd: flags.noSystemd,
  })
}

/** Whether `path` is a run dir right under `root`: `<root>/restart-leg-<name>`, nothing above it, nothing deeper. */
export const isRunDir = (root: string, path: string): boolean => {
  const base = trimSlash(root)
  if (!path.startsWith(`${base}/`)) return false
  const rest = path.slice(base.length + 1)
  return rest.startsWith(RUN_PREFIX) && rest.length > RUN_PREFIX.length && !rest.includes("/") && rest !== "." && rest !== ".."
}

/** Why a scratch service may not take `port`: the owner's 8240, a port the live service registers or is configured on. */
export const portRefusal = (port: number, live: ReadonlyArray<number>): Option.Option<string> => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return Option.some(`port ${port} is not a free user port`)
  if (port === NEVER_PORT) return Option.some(`port ${NEVER_PORT} is the owner's service port; a scratch service never takes it`)
  if (live.includes(port)) return Option.some(`port ${port} is the live service's (registered or configured); a scratch service never takes it`)
  return Option.none()
}

/** A launcher scope the run starts the service's clients in: named before the run, never the live service's. */
export const launcherUnit = (id: string, step: string): string => `${RUN_PREFIX}${id}-${step}.scope`

/** The scope a service process `pid` places itself in (mods/update/placement.ts `scopeName`). */
export const serviceScope = (pid: number): string => `opencode-service-${pid}.scope`

/** The launcher steps a full run names, in order. */
export const launcherSteps = (cases: ReadonlyArray<Case>): ReadonlyArray<string> => [
  "start",
  ...Arr.filter(["restart-a"], () => cases.includes("a")),
  ...Arr.filter(["start-c"], () => cases.includes("c")),
  ...Arr.filter(["start-d"], () => cases.includes("d")),
]

/** Why the run may not use `names`: one of them is listed by the user manager already, or is the live service's scope. */
export const nameClash = (names: ReadonlyArray<string>, listed: ReadonlyArray<string>, live: ReadonlyArray<string>): Option.Option<string> =>
  Option.map(Arr.findFirst(names, (name) => listed.includes(name) || live.includes(name)), (name) => {
    if (live.includes(name)) return `${name} is the live service's scope`
    return `the user manager already lists ${name}: another run's, or a name clash; refusing to start`
  })

/** The unit names in `systemctl --user list-units --type=scope --all --plain --no-legend` output: each line's first word. */
export const unitsOf = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim().replace(/^●\s*/, "").split(/\s+/)[0] ?? "")
    .filter((name) => name.endsWith(".scope"))

/** The cgroup v2 path in a `/proc/<pid>/cgroup` text, none without one. */
export const cgroupOf = (text: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(text.split("\n").find((line) => line.startsWith("0::"))), (line) => line.slice(3).trim())

/** A cgroup's unit: its last segment. */
export const unitOfCgroup = (cgroup: string): string => cgroup.split("/").at(-1) ?? ""

// ── Ownership ───────────────────────────────────────────────────────────

/** What `/proc/<pid>` says of a process: its command line and its environment, NUL-separated as read. */
export interface ProcView {
  readonly cmdline: string
  readonly environ: string
}

/**
 * Whether the run may signal `pid`: it recorded the pid as its own, and the process (as `/proc` reads it now)
 * carries the run dir in its environment or command line; why not, else. A pid that no longer reads is gone.
 */
export const ownsPid = (run: string, recorded: ReadonlyArray<number>, pid: number, view: Option.Option<ProcView>): Result.Result<true, string> => {
  if (!recorded.includes(pid)) return Result.fail(`pid ${pid} is not one the run recorded`)
  if (Option.isNone(view)) return Result.fail(`pid ${pid} is gone`)
  if (!view.value.cmdline.includes(run) && !view.value.environ.includes(run)) return Result.fail(`pid ${pid} does not carry ${run} in its command line or environment (reused by another process?)`)
  return Result.succeed(true)
}

/** Whether the run may stop `unit`: it recorded the unit, and every process in it is the run's (`ownsPid` with its pids as recorded). */
export const ownsUnit = (
  run: string,
  recorded: ReadonlyArray<string>,
  unit: string,
  procs: ReadonlyArray<{ readonly pid: number; readonly view: Option.Option<ProcView> }>,
): Result.Result<true, string> => {
  if (!recorded.includes(unit)) return Result.fail(`${unit} is not a unit the run recorded`)
  const foreign = procs.filter((proc) => Option.isSome(proc.view) && Result.isFailure(ownsPid(run, [proc.pid], proc.pid, proc.view)))
  if (foreign.length > 0) return Result.fail(`${unit} holds processes that are not the run's: ${foreign.map((proc) => proc.pid).join(", ")}`)
  return Result.succeed(true)
}

// ── Behaviour ───────────────────────────────────────────────────────────

/** What a stop (c, d) did to the shell and its session. */
export type Behaviour = "survived" | "woken-once" | "woken-more" | "queued" | "lost"

export interface Observed {
  /** The shell still runs after the stop. */
  readonly survived: boolean
  /** Model requests the session made by itself whose last message is the shell's notice. */
  readonly wakes: number
  /** The notice waited in the session's inbox, and its next prompt's request carried it. */
  readonly queued: boolean
}

export const behaviourOf = (seen: Observed): Behaviour => {
  if (seen.survived) return "survived"
  if (seen.wakes === 1) return "woken-once"
  if (seen.wakes > 1) return "woken-more"
  if (seen.queued) return "queued"
  return "lost"
}

/** The behaviour `--expect` passes: upstream's queued notice, or the fork's single wake. */
export const expected = (expect: Expect): Behaviour => {
  if (expect === "wake") return "woken-once"
  return "queued"
}

// ── Paths and commands ──────────────────────────────────────────────────

export interface RunPaths {
  readonly run: string
  readonly home: string
  readonly config: string
  readonly state: string
  readonly data: string
  readonly cache: string
  readonly tmp: string
  readonly work: string
  readonly clone: string
  /** The update plugin's own paths: all under the run dir, the ones it must never find absent from it. */
  readonly update: string
  readonly none: string
}

export const pathsOf = (run: string): RunPaths => ({
  run,
  home: `${run}/home`,
  config: `${run}/home/.config`,
  state: `${run}/home/.local/state`,
  data: `${run}/home/.local/share`,
  cache: `${run}/home/.cache`,
  tmp: `${run}/tmp`,
  work: `${run}/work`,
  clone: `${run}/bin/opencode-clone`,
  update: `${run}/update`,
  none: `${run}/none`,
})

/**
 * The update plugin's options: every path in the run dir. `checkout` does not exist, so its check fails at its
 * first step (`git fetch` with that cwd, mods/update/git/source.ts) before it reads a target, builds, writes a
 * record or hands off; `launcher`, `record` and `bun` do not exist either; `resident` is a directory no client opens.
 */
export const updateOptions = (paths: RunPaths, id: string) => ({
  host: `${RUN_PREFIX}${id}`,
  checkout: `${paths.none}/checkout`,
  fork: `${paths.none}/fork`,
  bun: `${paths.none}/bun`,
  launcher: `${paths.none}/launcher`,
  resident: `${paths.none}/resident`,
  record: `${paths.none}/installed.json`,
  config: [`${paths.config}/opencode/opencode.json`, `${paths.config}/opencode/cli.json`],
  notice: `${paths.update}/notice.json`,
  state: paths.update,
  everyMinutes: 1_000_000,
})

/** The scratch server config: the scripted model, and the tree's update entry with the scratch options. */
export const serverConfig = (paths: RunPaths, id: string, tree: string, modelPort: number) => ({
  autoupdate: false,
  model: "sim/sim-model",
  small_model: "sim/sim-model",
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "sim-key" },
      models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
    },
  },
  plugins: [{ package: `${tree}/entries/server/update`, options: updateOptions(paths, id) }],
})

/** The host variables a scratch service keeps: its PATH, its user bus (placement's `busctl --user`), the terminal basics. */
export const KEPT_ENV = ["PATH", "USER", "LOGNAME", "LANG", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const

/** The scratch service's environment: the host's PATH, user bus and terminal basics, everything else in the run dir. */
export const serviceEnv = (paths: RunPaths, host: Readonly<Record<string, string>>) => {
  const kept = KEPT_ENV.flatMap((key) => Option.toArray(Option.map(Option.fromNullishOr(host[key]), (value) => [key, value] as const)))
  return {
    ...Object.fromEntries(kept),
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    TMPDIR: paths.tmp,
    OPENCODE_DB: `${paths.run}/opencode.db`,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "true",
    RESTART_LEG_RUN: paths.run,
  }
}

/** The commands the run runs on the host, by name: the dry run prints these, the run runs these. */
export const commands = (paths: RunPaths) => ({
  listScopes: ["systemctl", "--user", "list-units", "--type=scope", "--all", "--plain", "--no-legend", "--no-pager"],
  showUnit: (unit: string) => ["systemctl", "--user", "show", unit, "--no-pager", "-p", "Id", "-p", "ActiveState", "-p", "SubState", "-p", "ControlGroup"],
  stopUnit: (unit: string) => ["systemctl", "--user", "stop", unit],
  inScope: (unit: string, argv: ReadonlyArray<string>) => ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, ...argv],
  service: (verb: "start" | "restart" | "stop") => [paths.clone, "service", verb],
  signal: (pid: number, signal: "TERM" | "KILL") => ["kill", `-${signal}`, String(pid)],
})

/** The prompt that has the model start tag's background shell, and the shell's own command. */
export const shellPrompt = (tag: string) => `run-shell ${tag}`
export const shellCommand = (work: string, tag: string) =>
  `echo $$ > '${work}/bg-${tag}.pid'; while [ ! -e '${work}/bg-${tag}.gate' ]; do sleep 0.2; done; echo finished > '${work}/bg-${tag}.done'; echo bg-finished-${tag}`

/** The notice a background shell's end sends its session (the fork's `ShellResult.notification`). */
export const NOTICE = '<background-result kind="shell"'
/** Whether `text` is tag's notice in `state`. */
export const isNotice = (text: string, tag: string, state: "completed" | "cancelled" | "any"): boolean =>
  text.includes(NOTICE) && text.includes(`bg-finished-${tag}`) && (state === "any" || text.includes(`state="${state}"`))

// ── Dry run ─────────────────────────────────────────────────────────────

/** A word as a shell reads it back: bare when it is plain, else single-quoted. */
const quoted = (word: string) => {
  if (/^[\w./=:@,+-]+$/.test(word)) return word
  return `'${word.replaceAll("'", "'\\''")}'`
}
const shown = (argv: ReadonlyArray<string>) => argv.map(quoted).join(" ")

/** Every command and file step a run of `input` takes, in order, with `<…>` for what only the run reads. */
export const planOf = (input: Input): ReadonlyArray<string> => {
  const paths = pathsOf(input.run)
  const run = commands(paths)
  const env = `env -i ${Object.entries(serviceEnv(paths, { PATH: "<PATH>", XDG_RUNTIME_DIR: "<XDG_RUNTIME_DIR>", DBUS_SESSION_BUS_ADDRESS: "<DBUS_SESSION_BUS_ADDRESS>" }))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`
  const inScope = (step: string, verb: "start" | "restart") => `${env} ${shown(run.inScope(launcherUnit(input.id, step), run.service(verb)))}`
  const ask = (what: string) => `http ${what}`
  const view = (label: string) => [`[b ${label}] ${shown(run.showUnit("<each scratch unit>"))}`, `[b ${label}] read /proc/<shell>/cgroup, /sys/fs/cgroup/<unit cgroup>/cgroup.procs`]
  const shell = (tag: string) => [
    ask(`POST /api/session {location:{directory:${paths.work}}}`),
    ask(`POST /api/session/<session ${tag}>/prompt {text:"${shellPrompt(tag)}"}`),
    `model answers: call shell {background:true, command:${shellCommand(paths.work, tag)}}`,
    `read ${paths.work}/bg-${tag}.pid; read /proc/<shell ${tag}>/environ (it must carry ${input.run})`,
  ]
  const observe = (tag: string) => [
    `wait up to ${input.waitMs} ms: the shell ${tag} ends; a model request with its cancelled notice (a wake), or ${ask(`GET /api/session/<session ${tag}>/inbox`)}`,
    `wait ${input.settleMs} ms more, count the wakes; with none: ${ask(`POST /api/session/<session ${tag}>/prompt {text:"what happened ${tag}"}`)} and read whether its request carries the notice`,
    `judge: ${expected(input.expect)} passes (--expect ${input.expect})`,
  ]
  const boot = (step: string, verb: "start" | "restart") => [
    inScope(step, verb),
    `wait up to ${input.waitMs} ms: ${ask("GET /api/info")} answers with a new pid <S>`,
    ask(`GET /api/location (x-opencode-directory ${paths.work}): the update plugin loads and places <S>`),
    `wait up to ${input.waitMs} ms: /proc/<S>/cgroup ends in ${serviceScope(0).replace("0", "<S>")}; refuse it if it was listed before the run or is the live scope`,
  ]
  const cases: Record<Case, ReadonlyArray<string>> = {
    a: [
      "## case a: service restart",
      ...shell("A"),
      ...view("before a"),
      ...boot("restart-a", "restart"),
      `the shell A is alive, ${ask("GET /api/shell?exited=true")} lists it running, its scope is active and its cgroup.procs hold it`,
      ...view("after a"),
      `write ${paths.work}/bg-A.gate; wait up to ${input.waitMs} ms for a model request whose last message is the completed notice of A`,
    ],
    c: [
      "## case c: signal stop",
      ...shell("C"),
      ...view("before c"),
      `own <S>: ${shown(run.signal(0, "TERM")).replace(" 0", " <S>")}`,
      ...boot("start-c", "start"),
      ...view("after c"),
      ...observe("C"),
    ],
    d: [
      "## case d: systemd stops the shell's scope",
      ...shell("D"),
      ...view("before d"),
      `own <the shell D's scope> and every pid in it: ${shown(run.stopUnit("<the shell D's scope>"))}`,
      `if <S> went with it: ${boot("start-d", "start").join("; ")}`,
      ...view("after d"),
      ...observe("D"),
    ],
  }
  return [
    `# restart-leg dry run: ${input.run} (expect ${input.expect}, cases ${input.cases.join(",")})`,
    "## preflight",
    `refuse unless linux; refuse ${input.run} unless it is a ${RUN_PREFIX}* dir right under ${input.root}`,
    `realpath ${input.tree} (the tree); binary: ${Option.getOrElse(input.binary, () => "<the tree's realpath without .plugins>")}`,
    "read the live registration ($XDG_STATE_HOME or ~/.local/state)/opencode/service*.json: pid, url port; the live config ~/.config/opencode/service*.json: port; /proc/<live pid>/cgroup",
    "stat ($XDG_STATE_HOME or ~/.local/state)/opencode-update/update.log (its size); readlink ~/.local/share/opencode-prime/current.plugins; read ~/.local/bin/opencode",
    shown(run.listScopes),
    `refuse a name clash: ${launcherSteps(input.cases).map((step) => launcherUnit(input.id, step)).join(", ")}`,
    `refuse port ${Option.getOrElse(Option.map(input.port, String), () => "<a free loopback port>")} if it is ${NEVER_PORT} or the live one`,
    `mkdir ${input.run} (it must not exist) and ${[paths.home, paths.tmp, paths.work, paths.update].join(", ")}`,
    `copy <binary> ${paths.clone}`,
    `write ${paths.config}/opencode/opencode.json (the scripted model, ${input.tree}/entries/server/update with every option under ${input.run}) and ${paths.config}/opencode/service.json {port}`,
    "serve the scripted model on 127.0.0.1:<free port>",
    `every http ask below goes to the scratch service as ${paths.state}/opencode/service*.json registers it (url, password), with x-opencode-directory ${paths.work}`,
    "## boot",
    ...boot("start", "start"),
    ...input.cases.flatMap((each) => cases[each]),
    "## cleanup (always)",
    `${env} ${shown(run.service("stop"))}`,
    `each recorded pid still alive and still carrying ${input.run}: ${shown(run.signal(0, "KILL")).replace(" 0", " <pid>")}`,
    `each recorded unit still active whose every process carries ${input.run}: ${shown(run.stopUnit("<unit>"))}`,
    "read the live registration, /proc/<live pid>/cgroup, the live update log (a line of this run in it is a change; its size is reported), the tree pointer and the launcher again: any change is exit 3",
    `check ${input.run} is a ${RUN_PREFIX}* dir right under ${input.root}, then remove ${input.run}`,
  ]
}

// ── Errors ──────────────────────────────────────────────────────────────

/** A precondition the run will not cross: exit 2. */
export class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}
/** A case's expectation did not hold: exit 1. */
export class CaseFailed extends Data.TaggedError("CaseFailed")<{ readonly step: string; readonly reason: string }> {}
/** The live service or the install differs from the start: exit 3. */
export class LiveChanged extends Data.TaggedError("LiveChanged")<{ readonly reason: string }> {}

const fail = (step: string, reason: string) => Effect.fail(new CaseFailed({ step, reason }))

// ── Host reads ──────────────────────────────────────────────────────────

/** One finished command: its exit and what it printed (stdout and stderr together). */
interface Ran {
  readonly code: number
  readonly out: string
}

const Registration = Schema.Struct({ url: Schema.String, password: Schema.optionalKey(Schema.String), pid: Schema.Number })
type Registration = typeof Registration.Type
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))
const decodePortConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ port: Schema.optionalKey(Schema.Number) })))
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const log = (line: string) => Console.log(`restart-leg: ${line}`)

/** `argv`, its output and exit; a command that cannot start fails the step. `detached: false` keeps a daemon it starts out of its group's kill. */
const exec = Effect.fn("RestartLeg.exec")(function* (argv: ReadonlyArray<string>, env: Option.Option<Record<string, string>>, timeoutMs: number, echo = true) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [command = "", ...args] = argv
  if (echo) yield* log(`$ ${shown(argv)}`)
  const options = Option.match(env, { onNone: () => ({}), onSome: (each) => ({ env: each, extendEnv: false }) })
  const ran = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { ...options, stdin: "ignore", detached: false, forceKillAfter: "3 seconds" }))
      return yield* Effect.all([handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: 2 }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
    }),
  ).pipe(Effect.mapError((error) => new CaseFailed({ step: shown(argv), reason: error.message })))
  return yield* Option.match(ran, {
    onNone: () => fail(shown(argv), `no exit in ${timeoutMs} ms`),
    onSome: ([out, code]): Effect.Effect<Ran> => Effect.succeed({ code: Number(code), out }),
  })
})

/** `argv` must exit 0: its output. */
const must = (argv: ReadonlyArray<string>, env: Option.Option<Record<string, string>>, timeoutMs: number) =>
  Effect.flatMap(exec(argv, env, timeoutMs), (ran) => {
    if (ran.code === 0) return Effect.succeed(ran.out)
    return fail(shown(argv), `exit ${ran.code}: ${ran.out.trim().slice(-800)}`)
  })

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.option)
  })

/** `/proc/<pid>`'s command line and environment, none once the pid is gone. */
const procView = (pid: number) =>
  Effect.gen(function* () {
    const cmdline = yield* readText(`/proc/${pid}/cmdline`)
    const environ = yield* readText(`/proc/${pid}/environ`)
    const proc = Option.map(cmdline, (text): ProcView => ({ cmdline: text, environ: Option.getOrElse(environ, () => "") }))
    const fs = yield* FileSystem.FileSystem
    if (Option.isSome(proc) || (yield* fs.exists("/proc/self").pipe(Effect.orElseSucceed(() => false)))) return proc
    return yield* psView(pid)
  })

/** A host with no `/proc` (the Mac's `--no-systemd` smoke): `ps -E` prints a process's command and, for the user's own, its environment. */
const psView = (pid: number) =>
  Effect.map(exec(["ps", "-E", "-ww", "-o", "command=", "-p", String(pid)], Option.none(), 60_000, false).pipe(Effect.option), (ran) =>
    Option.map(
      Option.filter(ran, (each) => each.code === 0 && each.out.trim() !== ""),
      (each): ProcView => ({ cmdline: each.out, environ: each.out }),
    ),
  )

const alive = (pid: number) => Effect.map(procView(pid), Option.isSome)

const cgroupNow = (pid: number) => Effect.map(readText(`/proc/${pid}/cgroup`), (text) => Option.flatMap(text, cgroupOf))

/** The registration files in an opencode state dir, decoded. */
const registrations = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    const texts = yield* Effect.forEach(
      names.filter((name) => /^service.*\.json$/.test(name)),
      (name) => readText(`${dir}/${name}`),
    )
    return Arr.getSomes(texts.map((text) => Option.flatMap(text, decodeRegistration)))
  })

/** What the run must leave as it found it: the live service, its scope, the install's pointer and launcher, the live update log. */
export interface LiveSnapshot {
  readonly pids: ReadonlyArray<number>
  readonly ports: ReadonlyArray<number>
  readonly scopes: ReadonlyArray<string>
  readonly tree: Option.Option<string>
  readonly launcher: Option.Option<string>
  readonly updateLog: string
  readonly updateLogSize: number
}

const portOf = (url: string) => Number(Option.getOrElse(Option.fromNullishOr(/:(\d+)(?:\/|$)/.exec(url)?.[1]), () => "0"))

const liveSnapshot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const home = yield* Config.String("HOME")
  const stateHome = Option.getOrElse(yield* Config.option(Config.String("XDG_STATE_HOME")), () => `${home}/.local/state`)
  const configHome = Option.getOrElse(yield* Config.option(Config.String("XDG_CONFIG_HOME")), () => `${home}/.config`)
  const live = yield* registrations(`${stateHome}/opencode`)
  const configNames = yield* fs.readDirectory(`${configHome}/opencode`).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  const configs = yield* Effect.forEach(
    configNames.filter((name) => /^service.*\.json$/.test(name)),
    (name) => readText(`${configHome}/opencode/${name}`),
  )
  const configured = Arr.getSomes(configs.map((text) => Option.flatMap(Option.flatMap(text, decodePortConfig), (each) => Option.fromUndefinedOr(each.port))))
  const scopes = yield* Effect.forEach(live, (each) => Effect.map(cgroupNow(each.pid), (cgroup) => Option.map(cgroup, unitOfCgroup)))
  const updateLog = `${stateHome}/opencode-update/update.log`
  const size = yield* fs.stat(updateLog).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  )
  return {
    pids: live.map((each) => each.pid),
    ports: [...live.map((each) => portOf(each.url)), ...configured],
    scopes: Arr.getSomes(scopes),
    tree: yield* fs.readLink(`${home}/.local/share/opencode-prime/current.plugins`).pipe(Effect.option),
    launcher: yield* readText(`${home}/.local/bin/opencode`),
    updateLog,
    updateLogSize: size,
  } satisfies LiveSnapshot
})

const same = (one: Option.Option<string>, two: Option.Option<string>) => Option.getOrElse(one, () => "\0") === Option.getOrElse(two, () => "\0")

/** The differences between the live snapshot at the start and now. The live update log may change by the live updater's own lines (its size moved under a Mac smoke run with no line of the run in it: 299776 bytes, then 299775), never by a line of this run, which names its host `restart-leg-<id>`. */
export const liveDifferences = (before: LiveSnapshot, after: LiveSnapshot, updateLog: string, id: string): ReadonlyArray<string> => [
  ...Arr.filter([`the live service pids were ${before.pids.join(",")} and are ${after.pids.join(",")}`], () => before.pids.join(",") !== after.pids.join(",")),
  ...Arr.filter([`the live service scopes were ${before.scopes.join(",")} and are ${after.scopes.join(",")}`], () => before.scopes.join(",") !== after.scopes.join(",")),
  ...Arr.filter(["the installed tree's pointer (current.plugins) changed"], () => !same(before.tree, after.tree)),
  ...Arr.filter(["the launcher ~/.local/bin/opencode changed"], () => !same(before.launcher, after.launcher)),
  ...Arr.filter([`the live update log ${before.updateLog} has a line of this run (${RUN_PREFIX}${id})`], () => updateLog.includes(`${RUN_PREFIX}${id}`)),
]

// ── The scripted model ──────────────────────────────────────────────────

/** One request the model got: its last message, and every message's text, oldest first. */
export interface Asked {
  readonly last: string
  readonly history: ReadonlyArray<string>
}

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.OptionFromOptionalNullOr(Content) })) })

const textOf = (content: Option.Option<Content>): string =>
  Option.match(content, {
    onNone: () => "",
    onSome: (present) => {
      if (Predicate.isString(present)) return present
      return present.map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => "")).join("")
    },
  })

/** One streamed delta: the role, a text, or the tool calls. */
interface Delta {
  readonly role?: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{ readonly index: number; readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } }>
}

/** The text that ends a turn: a notice is acknowledged, anything else noted. */
const replyTo = (last: string) => {
  if (last.includes(NOTICE)) return "Done."
  return "Noted."
}

const chunk = (delta: Delta, finish: Option.Option<string>) => ({ id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: Option.getOrNull(finish) }] })
const USAGE = { id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
const stream = (events: ReadonlyArray<object>) => [...events, USAGE].map((event) => `data: ${toJson(event)}\n\n`).join("") + "data: [DONE]\n\n"

/** The model's answer: `run-shell <tag>` calls the shell tool with tag's background command; anything else a line. */
export const answerOf = (asked: Asked, work: string, call: number): string => {
  const tag = Option.fromNullishOr(/^run-shell (\w+)$/m.exec(asked.last)?.[1])
  return Option.match(tag, {
    onNone: () => stream([chunk({ role: "assistant", content: "" }, Option.none()), chunk({ content: replyTo(asked.last) }, Option.none()), chunk({}, Option.some("stop"))]),
    onSome: (named) => {
      const args = { command: shellCommand(work, named), background: true, description: `job ${named}` }
      const tool = { index: 0, id: `call_shell_${call}`, type: "function", function: { name: "shell", arguments: toJson(args) } }
      return stream([chunk({ role: "assistant", content: "" }, Option.none()), chunk({ tool_calls: [tool] }, Option.none()), chunk({}, Option.some("tool_calls"))])
    },
  })
}

const model = (work: string, asks: Ref.Ref<ReadonlyArray<Asked>>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest)
    const system = body.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content)).join("\n")
    const events = { contentType: "text/event-stream" }
    if (system.includes("You name conversations")) return HttpServerResponse.text(stream([chunk({ role: "assistant", content: "Restart leg" }, Option.none()), chunk({}, Option.some("stop"))]), events)
    const asked: Asked = {
      last: textOf(Option.flatten(Option.map(Arr.last(body.messages), (message) => message.content))),
      history: body.messages.filter((message) => message.role !== "system" && message.role !== "developer").map((message) => textOf(message.content)),
    }
    const count = yield* Ref.modify(asks, (all) => [all.length, [...all, asked]] as const)
    return HttpServerResponse.text(answerOf(asked, work, count), events)
  }).pipe(Effect.orDie)

// ── The scratch service ─────────────────────────────────────────────────

/** What the run recorded as its own, for cleanup's ownership check. */
interface Owned {
  readonly pids: Ref.Ref<ReadonlyArray<number>>
  readonly units: Ref.Ref<ReadonlyArray<string>>
}

interface Ctx {
  readonly input: Input
  readonly paths: RunPaths
  readonly env: Record<string, string>
  readonly asks: Ref.Ref<ReadonlyArray<Asked>>
  readonly owned: Owned
  /** The scopes the user manager listed before the run. */
  readonly listed: ReadonlyArray<string>
  readonly live: LiveSnapshot
  /** The scratch service now. */
  readonly current: Ref.Ref<Option.Option<Registration>>
  /** The run made its run dir: only then does cleanup remove it. */
  readonly made: Ref.Ref<boolean>
}

const record = <A>(ref: Ref.Ref<ReadonlyArray<A>>, value: A) => Ref.update(ref, (all) => Arr.dedupe([...all, value]))

/** Polls `read` every `everyMs` until it answers some, at most `waitMs`; none after. */
const until = <A, E, R>(read: Effect.Effect<Option.Option<A>, E, R>, waitMs: number, everyMs = 500) =>
  read.pipe(
    Effect.flatMap((got) => Effect.fromOption(got)),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(everyMs)), times: Math.ceil(waitMs / everyMs) }),
    Effect.option,
  )

const mustUntil = <A, E, R>(step: string, read: Effect.Effect<Option.Option<A>, E, R>, waitMs: number, why: string) =>
  Effect.flatMap(until(read, waitMs), (got) => Option.match(got, { onNone: () => fail(step, `${why} after ${waitMs} ms`), onSome: (value) => Effect.succeed(value) }))

/** One HTTP ask of the scratch service, in the work location; its JSON answer (or text), failing on a non-2xx status. */
const api = Effect.fn("RestartLeg.api")(function* (ctx: Ctx, method: "GET" | "POST", route: string, body: Option.Option<object>) {
  const client = yield* HttpClient.HttpClient
  const service = yield* Effect.flatMap(Ref.get(ctx.current), (current) => Effect.mapError(Effect.fromOption(current), () => new CaseFailed({ step: route, reason: "no scratch service is up" })))
  const base = HttpClientRequest.make(method)(new URL(route, service.url), { headers: { "x-opencode-directory": encodeURIComponent(ctx.paths.work) } })
  const authed = Option.match(Option.fromUndefinedOr(service.password), { onNone: () => base, onSome: (password) => HttpClientRequest.basicAuth(base, "opencode", Redacted.make(password)) })
  const sent = Option.match(body, { onNone: () => authed, onSome: (each) => HttpClientRequest.bodyText(authed, toJson(each), "application/json") })
  const response = yield* client.execute(sent).pipe(Effect.timeout(Duration.millis(ctx.input.waitMs)), Effect.mapError((error) => new CaseFailed({ step: `${method} ${route}`, reason: String(error) })))
  const text = yield* response.text.pipe(Effect.mapError((error) => new CaseFailed({ step: `${method} ${route}`, reason: error.message })))
  if (response.status < 200 || response.status >= 300) return yield* fail(`${method} ${route}`, `${response.status} ${text.slice(0, 400)}`)
  return text
})

/** The scratch registration once it answers `/api/info`, with a pid other than `previous`. */
const answering = (ctx: Ctx, previous: Option.Option<number>) =>
  Effect.gen(function* () {
    const found = Arr.head(yield* registrations(`${ctx.paths.state}/opencode`))
    const fresh = Option.filter(found, (each) => !Option.contains(previous, each.pid))
    if (Option.isNone(fresh)) return Option.none<Registration>()
    yield* Ref.set(ctx.current, fresh)
    const info = yield* api(ctx, "GET", "/api/info", Option.none()).pipe(Effect.option)
    return Option.map(info, () => fresh.value)
  })

/** Has the service's client start or restart it from the run's own launcher scope, waits for a new pid, opens the work location and waits for its placement. */
const boot = Effect.fn("RestartLeg.boot")(function* (ctx: Ctx, step: string, verb: "start" | "restart") {
  const run = commands(ctx.paths)
  const previous = Option.map(yield* Ref.get(ctx.current), (each) => each.pid)
  const unit = launcherUnit(ctx.input.id, step)
  const argv = Option.match(Option.liftPredicate(unit, () => !ctx.input.noSystemd), { onNone: () => run.service(verb), onSome: (named) => run.inScope(named, run.service(verb)) })
  if (!ctx.input.noSystemd) yield* record(ctx.owned.units, unit)
  yield* must(argv, Option.some(ctx.env), ctx.input.waitMs)
  const service = yield* mustUntil(step, answering(ctx, previous), ctx.input.waitMs, "no new scratch service answered /api/info")
  yield* record(ctx.owned.pids, service.pid)
  yield* log(`${step}: the scratch service is pid ${service.pid} at ${service.url}`)
  yield* api(ctx, "GET", "/api/location", Option.none())
  if (ctx.input.noSystemd) return service
  return yield* placed(ctx, step, service)
})

/** Waits for the update plugin to place `service` in its own scope; refuses a scope listed before the run, records it. */
const placed = Effect.fn("RestartLeg.placed")(function* (ctx: Ctx, step: string, service: Registration) {
  const scope = serviceScope(service.pid)
  const inScope = yield* until(Effect.map(cgroupNow(service.pid), (cgroup) => Option.filter(cgroup, (each) => unitOfCgroup(each) === scope)), ctx.input.waitMs)
  if (Option.isNone(inScope)) {
    const where = yield* cgroupNow(service.pid)
    const updateLog = yield* readText(`${ctx.paths.update}/update.log`)
    return yield* fail(step, `the service was not placed in ${scope}; it runs in ${Option.getOrElse(where, () => "(gone)")}; update log: ${Option.getOrElse(updateLog, () => "(none)").slice(-800)}`)
  }
  if (ctx.listed.includes(scope) || ctx.live.scopes.includes(scope)) return yield* new Refused({ reason: `the scratch service's scope ${scope} was listed before the run or is the live one` })
  yield* record(ctx.owned.units, scope)
  yield* log(`${step}: placed in ${scope}`)
  return service
})

/** A session in the work location; its id. */
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })))
const openSession = (ctx: Ctx, tag: string) =>
  Effect.map(api(ctx, "POST", "/api/session", Option.some({ title: `restart leg ${tag}`, location: { directory: ctx.paths.work } })), (text) =>
    Option.getOrElse(Option.map(decodeSession(text), (session) => session.data.id), () => ""),
  )

const prompt = (ctx: Ctx, session: string, text: string) => api(ctx, "POST", `/api/session/${session}/prompt`, Option.some({ text }))

/** Starts tag's background shell in a new session: the session, and the shell's pid once it runs and the model has the call's result. */
const startShell = Effect.fn("RestartLeg.startShell")(function* (ctx: Ctx, tag: string) {
  const session = yield* openSession(ctx, tag)
  if (session === "") return yield* fail(`shell ${tag}`, "the session was not made")
  yield* prompt(ctx, session, shellPrompt(tag))
  const pidText = yield* mustUntil(`shell ${tag}`, readText(`${ctx.paths.work}/bg-${tag}.pid`), ctx.input.waitMs, "the background shell wrote no pid")
  const pid = Number(pidText.trim())
  const view = yield* procView(pid)
  const owned = ownsPid(ctx.paths.run, [pid], pid, view)
  if (Result.isFailure(owned)) return yield* fail(`shell ${tag}`, owned.failure)
  yield* record(ctx.owned.pids, pid)
  const answered = Effect.map(Ref.get(ctx.asks), (all) =>
    Option.liftPredicate(true, () => all.some((asked) => asked.history.some((each) => each.includes(shellPrompt(tag))) && !asked.last.includes(shellPrompt(tag)))),
  )
  yield* mustUntil(`shell ${tag}`, answered, ctx.input.waitMs, "the model never got the shell call's result")
  yield* log(`shell ${tag}: pid ${pid} in session ${session}`)
  return { session, pid }
})

/** The pids in a unit's cgroup (cgroup v2 under /sys/fs/cgroup). */
const unitProcs = (cgroup: string) => Effect.map(readText(`/sys/fs/cgroup${cgroup}/cgroup.procs`), (text) => Option.getOrElse(text, () => "").split("\n").filter((line) => line.trim() !== "").map(Number))

/** systemctl's view of a unit: its properties, and the pids in its cgroup. */
const unitView = (ctx: Ctx, unit: string) =>
  Effect.gen(function* () {
    const shown = yield* exec(commands(ctx.paths).showUnit(unit), Option.none(), 60_000)
    const props = Object.fromEntries(shown.out.split("\n").flatMap((line) => Arr.filter([line.split("=")], (pair) => pair.length >= 2).map(([key = "", ...rest]) => [key, rest.join("=")])))
    const cgroup = Option.getOrElse(Option.fromNullishOr(props["ControlGroup"]), () => "")
    const procs = yield* Effect.map(Effect.forEach(Arr.filter([cgroup], (each) => each !== ""), unitProcs), (each) => each.flat())
    return { unit, active: `${props["ActiveState"] ?? "?"}/${props["SubState"] ?? "?"}`, cgroup, procs }
  })

/** Case b: systemd's view now: every recorded unit and the shell's cgroup. */
const systemdView = Effect.fn("RestartLeg.systemdView")(function* (ctx: Ctx, label: string, shell: number) {
  const units = yield* Ref.get(ctx.owned.units)
  const views = yield* Effect.forEach(
    units.filter((unit) => unit.startsWith("opencode-service-")),
    (unit) => unitView(ctx, unit),
  )
  const shellCgroup = Option.getOrElse(yield* cgroupNow(shell), () => "(none: gone, or no cgroup on this host)")
  const view = { case: "b", at: label, shell: { pid: shell, cgroup: shellCgroup }, units: views }
  yield* Console.log(toJson(view))
  return view
})

const decodeShells = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Struct({ pid: Schema.optionalKey(Schema.Number), status: Schema.String })) })))
/** The shells the service lists in the work location, exited ones too. */
const listedShells = (ctx: Ctx) =>
  Effect.map(api(ctx, "GET", `/api/shell?exited=true&location[directory]=${encodeURIComponent(ctx.paths.work)}`, Option.none()), (text) =>
    Option.getOrElse(Option.map(decodeShells(text), (listed) => listed.data.map((shell) => ({ pid: Option.getOrElse(Option.fromUndefinedOr(shell.pid), () => 0), status: shell.status }))), () => []),
  )

/** Case a: the restart's handoff keeps the shell, its scope, the listing, and the end notice wakes the session. */
const caseA = Effect.fn("RestartLeg.caseA")(function* (ctx: Ctx) {
  const shell = yield* startShell(ctx, "A")
  const before = yield* systemdView(ctx, "before a", shell.pid)
  const holder = unitOfCgroup(before.shell.cgroup)
  yield* boot(ctx, "restart-a", "restart")
  if (!(yield* alive(shell.pid))) return yield* fail("a", `the shell ${shell.pid} did not survive the restart`)
  const listed = yield* listedShells(ctx)
  if (!listed.some((each) => each.pid === shell.pid && each.status === "running")) return yield* fail("a", `the new server does not list the shell ${shell.pid} running: ${toJson(listed)}`)
  const after = yield* systemdView(ctx, "after a", shell.pid)
  const found = Arr.findFirst(after.units, (each) => each.unit === holder)
  const held = Option.filter(found, (each) => each.active.startsWith("active") && each.procs.includes(shell.pid))
  if (!ctx.input.noSystemd && Option.isNone(held)) return yield* fail("a", `the scope ${holder} the shell ran in is not active holding it after the restart: ${toJson(Option.getOrElse(found, () => "not listed"))}`)
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(`${ctx.paths.work}/bg-A.gate`, "").pipe(Effect.mapError((error) => new CaseFailed({ step: "a", reason: error.message })))
  const woke = Effect.map(Ref.get(ctx.asks), (all) => Arr.findFirst(all, (asked) => isNotice(asked.last, "A", "completed")))
  yield* mustUntil("a", woke, ctx.input.waitMs, "no model request carried the completed notice of A (the session was not woken by it)")
  const why = Option.match(held, {
    onNone: () => "no systemd here (--no-systemd): the shell survived the handoff with the PTY daemon that runs it",
    onSome: (each) => `the old service's scope ${holder} outlived it: it still held ${each.procs.join(", ")} (the PTY daemon and the shell) after the handoff, and a scope is only collected once empty`,
  })
  yield* Console.log(toJson({ case: "a", pass: true, shell: shell.pid, scope: holder, why }))
})

/** After a stop (c, d): whether the shell survived, how many times its session woke with the notice, and whether its next turn carried it. */
const observe = Effect.fn("RestartLeg.observe")(function* (ctx: Ctx, tag: string, session: string, pid: number) {
  const gone = yield* until(Effect.map(alive(pid), (up) => Option.liftPredicate(true, () => !up)), ctx.input.waitMs)
  if (Option.isNone(gone)) return { survived: true, wakes: 0, queued: false } satisfies Observed
  const wakes = Effect.map(Ref.get(ctx.asks), (all) => all.filter((asked) => isNotice(asked.last, tag, "any")).length)
  const inbox = Effect.map(api(ctx, "GET", `/api/session/${session}/inbox`, Option.none()).pipe(Effect.orElseSucceed(() => "")), (text) => text.includes("background-result") && text.includes(`bg-finished-${tag}`))
  yield* until(
    Effect.map(Effect.all([wakes, inbox]), ([count, queued]) => Option.liftPredicate(true, () => count > 0 || queued)),
    ctx.input.waitMs,
  )
  yield* Effect.sleep(Duration.millis(ctx.input.settleMs))
  const woken = yield* wakes
  if (woken > 0) return { survived: false, wakes: woken, queued: false } satisfies Observed
  yield* prompt(ctx, session, `what happened ${tag}`)
  const next = yield* until(
    Effect.map(Ref.get(ctx.asks), (all) => Arr.findFirst(all, (asked) => asked.last.includes(`what happened ${tag}`))),
    ctx.input.waitMs,
  )
  const carried = Option.exists(next, (asked) => asked.history.some((each) => isNotice(each, tag, "any")))
  return { survived: false, wakes: 0, queued: carried } satisfies Observed
})

const judge = (ctx: Ctx, label: Case, seen: Observed, extra: Readonly<Record<string, string | number | boolean>>) =>
  Effect.gen(function* () {
    const behaviour = behaviourOf(seen)
    const pass = behaviour === expected(ctx.input.expect)
    yield* Console.log(toJson({ case: label, pass, behaviour, expected: expected(ctx.input.expect), ...seen, ...extra }))
    if (!pass) return yield* fail(label, `saw ${behaviour}, expected ${expected(ctx.input.expect)} (--expect ${ctx.input.expect})`)
  })

/** Whether the run may signal or stop: the pid's ownership, read now. */
const ownedPid = (ctx: Ctx, pid: number) =>
  Effect.gen(function* () {
    return ownsPid(ctx.paths.run, yield* Ref.get(ctx.owned.pids), pid, yield* procView(pid))
  })

/** Case c: SIGTERM to the scratch service, then a start. */
const caseC = Effect.fn("RestartLeg.caseC")(function* (ctx: Ctx) {
  const service = yield* Effect.flatMap(Ref.get(ctx.current), (current) => Effect.mapError(Effect.fromOption(current), () => new CaseFailed({ step: "c", reason: "no scratch service" })))
  const shell = yield* startShell(ctx, "C")
  yield* systemdView(ctx, "before c", shell.pid)
  const owned = yield* ownedPid(ctx, service.pid)
  if (Result.isFailure(owned)) return yield* new Refused({ reason: `c: ${owned.failure}` })
  yield* must(commands(ctx.paths).signal(service.pid, "TERM"), Option.none(), 60_000)
  yield* mustUntil("c", Effect.map(alive(service.pid), (up) => Option.liftPredicate(true, () => !up)), ctx.input.waitMs, `the scratch service ${service.pid} did not exit on SIGTERM`)
  yield* boot(ctx, "start-c", "start")
  yield* systemdView(ctx, "after c", shell.pid)
  yield* judge(ctx, "c", yield* observe(ctx, "C", shell.session, shell.pid), { shell: shell.pid, stopped: service.pid })
})

/** Case d: `systemctl --user stop` on the scope that holds the shell, then a start if the service went with it. */
const caseD = Effect.fn("RestartLeg.caseD")(function* (ctx: Ctx) {
  const service = yield* Effect.flatMap(Ref.get(ctx.current), (current) => Effect.mapError(Effect.fromOption(current), () => new CaseFailed({ step: "d", reason: "no scratch service" })))
  const shell = yield* startShell(ctx, "D")
  const before = yield* systemdView(ctx, "before d", shell.pid)
  const scope = unitOfCgroup(before.shell.cgroup)
  const procs = yield* unitProcs(before.shell.cgroup)
  const views = yield* Effect.forEach(procs, (pid) => Effect.map(procView(pid), (view) => ({ pid, view })))
  const owned = ownsUnit(ctx.paths.run, yield* Ref.get(ctx.owned.units), scope, views)
  if (Result.isFailure(owned)) return yield* new Refused({ reason: `d: ${owned.failure}` })
  yield* must(commands(ctx.paths).stopUnit(scope), Option.none(), ctx.input.waitMs)
  const serviceUp = yield* alive(service.pid)
  if (!serviceUp) yield* boot(ctx, "start-d", "start")
  yield* systemdView(ctx, "after d", shell.pid)
  yield* judge(ctx, "d", yield* observe(ctx, "D", shell.session, shell.pid), { shell: shell.pid, stoppedScope: scope, serviceSurvived: serviceUp })
})

// ── Setup and cleanup ───────────────────────────────────────────────────

/** A free loopback port, by binding port 0 and letting it go. */
const freePort = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    return Number(HttpServer.formatAddress(server.address).split(":").at(-1))
  }).pipe(Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))),
)

/** The scopes the user manager lists now; a manager that does not answer refuses the run. */
const listUnits = (input: Input) =>
  Effect.flatMap(exec(commands(pathsOf(input.run)).listScopes, Option.none(), 60_000), (listed) => {
    if (listed.code !== 0) return Effect.fail(new Refused({ reason: `no user systemd answers (systemctl --user exited ${listed.code}): ${listed.out.trim()}` }))
    return Effect.succeed(unitsOf(listed.out))
  })

const preflight = Effect.fn("RestartLeg.preflight")(function* (input: Input) {
  const fs = yield* FileSystem.FileSystem
  const system = (yield* exec(["uname", "-s"], Option.none(), 60_000)).out.trim()
  if (input.noSystemd && system === "Linux") return yield* new Refused({ reason: "--no-systemd is the Mac smoke; on Linux the leg runs with systemd" })
  if (!input.noSystemd && system !== "Linux") return yield* new Refused({ reason: `${system} has no user systemd: the leg runs on Linux (the workbox); --dry-run prints its commands anywhere, --no-systemd smokes cases a and c here` })
  if (!isRunDir(input.root, input.run)) return yield* new Refused({ reason: `${input.run} is not a ${RUN_PREFIX}* dir right under ${input.root}` })
  if (!(yield* fs.exists(input.root))) return yield* new Refused({ reason: `the scratch root ${input.root} does not exist` })
  if (yield* fs.exists(input.run)) return yield* new Refused({ reason: `${input.run} exists already` })
  const tree = yield* fs.realPath(input.tree).pipe(Effect.mapError(() => new Refused({ reason: `no installed tree at ${input.tree}` })))
  const binary = Option.getOrElse(input.binary, () => tree.replace(/\.plugins$/, ""))
  if (!(yield* fs.exists(binary)) || !(yield* fs.exists(`${tree}/entries/server/update`))) return yield* new Refused({ reason: `no build at ${binary} or no update entry in ${tree}` })
  const listed = yield* Effect.map(Effect.forEach(Arr.filter([input], () => !input.noSystemd), listUnits), (each) => each.flat())
  const live = yield* liveSnapshot
  const clash = nameClash(launcherSteps(input.cases).map((step) => launcherUnit(input.id, step)), listed, live.scopes)
  if (Option.isSome(clash)) return yield* new Refused({ reason: clash.value })
  const port = yield* Option.match(input.port, { onNone: () => freePort, onSome: (given) => Effect.succeed(given) })
  const refused = portRefusal(port, live.ports)
  if (Option.isSome(refused)) return yield* new Refused({ reason: refused.value })
  yield* log(`live: pids ${live.pids.join(",") || "none"}, ports ${live.ports.join(",") || "none"}, scopes ${live.scopes.join(",") || "none"}; ${listed.length} user scopes listed`)
  return { tree, binary, listed, live, port }
})

/** The run dir (made here, never one that exists: `made` says so to cleanup), the clone of the build, the scratch configs. */
const setup = Effect.fn("RestartLeg.setup")(function* (ctx: Ctx, tree: string, binary: string, port: number, modelPort: number) {
  const fs = yield* FileSystem.FileSystem
  const { input, paths } = ctx
  yield* fs.makeDirectory(input.run, { recursive: false })
  yield* Ref.set(ctx.made, true)
  yield* Effect.forEach([paths.home, `${paths.config}/opencode`, paths.state, paths.data, paths.cache, paths.tmp, paths.work, paths.update, `${input.run}/bin`], (dir) =>
    fs.makeDirectory(dir, { recursive: true }),
  )
  yield* log(`copy ${binary} ${paths.clone}`)
  yield* fs.copyFile(binary, paths.clone)
  yield* fs.chmod(paths.clone, 0o755)
  yield* fs.writeFileString(`${paths.config}/opencode/opencode.json`, toJson(serverConfig(paths, input.id, tree, modelPort)))
  yield* fs.writeFileString(`${paths.config}/opencode/service.json`, toJson({ port }))
  return paths
})

/** Cleanup: the scratch service stopped, each recorded pid and unit still the run's stopped, the live state compared, the run dir removed. */
const cleanup = Effect.fn("RestartLeg.cleanup")(function* (ctx: Ctx) {
  const fs = yield* FileSystem.FileSystem
  const run = commands(ctx.paths)
  yield* exec(run.service("stop"), Option.some(ctx.env), ctx.input.waitMs).pipe(Effect.ignore)
  const pids = yield* Ref.get(ctx.owned.pids)
  yield* Effect.forEach(pids, (pid) =>
    Effect.gen(function* () {
      const owned = ownsPid(ctx.paths.run, pids, pid, yield* procView(pid))
      if (Result.isSuccess(owned)) yield* exec(run.signal(pid, "KILL"), Option.none(), 60_000).pipe(Effect.ignore)
      else yield* log(`cleanup: not signalling ${pid}: ${owned.failure}`)
    }),
  )
  const units = yield* Ref.get(ctx.owned.units)
  yield* Effect.forEach(units, (unit) =>
    Effect.gen(function* () {
      const view = yield* unitView(ctx, unit).pipe(Effect.option)
      if (Option.isNone(view) || !view.value.active.startsWith("active")) return
      const procs = yield* Effect.forEach(view.value.procs, (pid) => Effect.map(procView(pid), (each) => ({ pid, view: each })))
      const owned = ownsUnit(ctx.paths.run, units, unit, procs)
      if (Result.isSuccess(owned)) yield* exec(run.stopUnit(unit), Option.none(), ctx.input.waitMs).pipe(Effect.ignore)
      else yield* log(`cleanup: not stopping ${unit}: ${owned.failure}`)
    }),
  )
  const after = yield* liveSnapshot
  const updateLog = Option.getOrElse(yield* readText(ctx.live.updateLog), () => "")
  const differences = liveDifferences(ctx.live, after, updateLog, ctx.input.id)
  yield* log(`live after: pids ${after.pids.join(",") || "none"}, scopes ${after.scopes.join(",") || "none"}; the live update log ${ctx.live.updateLog} was ${ctx.live.updateLogSize} bytes and is ${after.updateLogSize}, with no line of this run: ${!updateLog.includes(`${RUN_PREFIX}${ctx.input.id}`)}`)
  const made = yield* Ref.get(ctx.made)
  if (made && !isRunDir(ctx.input.root, ctx.paths.run)) return yield* new LiveChanged({ reason: `refusing to remove ${ctx.paths.run}: not a ${RUN_PREFIX}* dir right under ${ctx.input.root}` })
  if (made) yield* fs.remove(ctx.paths.run, { recursive: true }).pipe(Effect.andThen(log(`removed ${ctx.paths.run}`)))
  if (differences.length > 0) return yield* new LiveChanged({ reason: differences.join("; ") })
})

/** The run: preflight, setup, boot, each case, and the cleanup whatever happened. */
export const drive = Effect.fn("RestartLeg.drive")(function* (input: Input) {
  const found = yield* preflight(input)
  const asks = yield* Ref.make<ReadonlyArray<Asked>>([])
  yield* HttpServer.serveEffect(model(`${input.run}/work`, asks))
  const server = yield* HttpServer.HttpServer
  const modelPort = Number(HttpServer.formatAddress(server.address).split(":").at(-1))
  const paths = pathsOf(input.run)
  const host = Object.fromEntries(
    (yield* Effect.forEach(KEPT_ENV, (key) => Effect.map(Config.option(Config.String(key)), (value) => Option.toArray(Option.map(value, (text) => [key, text] as const))))).flat(),
  )
  const ctx: Ctx = {
    input,
    paths,
    env: serviceEnv(paths, host),
    asks,
    owned: { pids: yield* Ref.make<ReadonlyArray<number>>([]), units: yield* Ref.make<ReadonlyArray<string>>([]) },
    listed: found.listed,
    live: found.live,
    current: yield* Ref.make(Option.none<Registration>()),
    made: yield* Ref.make(false),
  }
  const cases = { a: caseA, c: caseC, d: caseD }
  const body = Effect.gen(function* () {
    yield* setup(ctx, found.tree, found.binary, found.port, modelPort).pipe(Effect.mapError((error) => new CaseFailed({ step: "setup", reason: error.message })))
    yield* boot(ctx, "start", "start")
    yield* Effect.forEach(input.cases, (each) => cases[each](ctx), { discard: true })
  })
  const outcome = yield* Effect.exit(body)
  yield* cleanup(ctx)
  yield* outcome
  yield* log(`PASS expect=${input.expect} cases=${input.cases.join(",")}${Arr.filter(["; a: the shell survived the restart and its notice woke the session"], () => input.cases.includes("a")).join("")}`)
})

// ── CLI ─────────────────────────────────────────────────────────────────

class Exited extends Data.TaggedError("RestartLegExit")<{ readonly code: number }> {}
const decodeExited = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.Literal("RestartLegExit"), code: Schema.Number }))

/** The run id: the time to the second and a random number, so two runs never share a dir (and the preflight refuses one that exists). */
export const runIdOf = (millis: number, salt: number) => `${millis}-${salt}`
const runId = Effect.gen(function* () {
  return runIdOf(yield* Clock.currentTimeMillis, yield* Random.nextIntBetween(10_000, 99_999))
})

const command = Command.make(
  "restart-leg",
  {
    root: Flag.String("root").pipe(Flag.withDescription("The scratch root; the run dir is <root>/restart-leg-<id> (on the workbox: /dev/shm)")),
    expect: Flag.String("expect").pipe(Flag.withDescription("c and d: no-wake (upstream) or wake (the fork's restart wake)"), Flag.withDefault("no-wake")),
    cases: Flag.String("cases").pipe(Flag.withDescription("a,c,d (b is every case's systemd view)"), Flag.withDefault("a,c,d")),
    port: Flag.Int("port").pipe(Flag.withDescription("The scratch service's port (default: a free one); never 8240 or the live one"), Flag.optional),
    tree: Flag.String("tree").pipe(Flag.withDescription("The installed plugin tree (default ~/.local/share/opencode-prime/current.plugins)"), Flag.optional),
    binary: Flag.String("binary").pipe(Flag.withDescription("The installed build (default: the tree's path without .plugins)"), Flag.optional),
    waitMs: Flag.Int("wait-ms").pipe(Flag.withDescription("How long each wait may take"), Flag.withDefault(300_000)),
    settleMs: Flag.Int("settle-ms").pipe(Flag.withDescription("How long c and d count wakes after the first sign"), Flag.withDefault(20_000)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Print every command and step the run would take; run nothing"), Flag.withDefault(false)),
    noSystemd: Flag.Boolean("no-systemd").pipe(Flag.withDescription("The Mac smoke of cases a and c: no launcher scopes, placement or systemd view (refused on Linux)"), Flag.withDefault(false)),
  },
  Effect.fn("RestartLeg.main")(function* (flags) {
    const home = yield* Config.String("HOME")
    const made = inputOf(flags, home, yield* runId)
    if (Result.isFailure(made)) return yield* Console.error(`restart-leg: ${made.failure}`).pipe(Effect.andThen(new Exited({ code: 2 })))
    if (made.success.dryRun) return yield* Effect.forEach(planOf(made.success), (line) => Console.log(line), { discard: true })
    yield* drive(made.success).pipe(
      Effect.scoped,
      Effect.catchTags({
        Refused: (refused) => Console.error(`restart-leg: REFUSED: ${refused.reason}`).pipe(Effect.andThen(new Exited({ code: 2 }))),
        CaseFailed: (failed) => Console.error(`restart-leg: FAIL at ${failed.step}: ${failed.reason}`).pipe(Effect.andThen(new Exited({ code: 1 }))),
        LiveChanged: (changed) => Console.error(`restart-leg: LIVE CHANGED: ${changed.reason}`).pipe(Effect.andThen(new Exited({ code: 3 }))),
      }),
    )
  }),
)

const live = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))

const exitCodeOf = <E, A>(exit: Exit.Exit<A, E>): number =>
  Exit.match(exit, {
    onSuccess: () => 0,
    onFailure: (cause) => Option.getOrElse(Option.map(Option.flatMap(Cause.findErrorOption(cause), decodeExited), (exited) => exited.code), () => 2),
  })

if (import.meta.main)
  BunRuntime.runMain(
    Command.run(command, { version: "1.0.0" }).pipe(
      Effect.tapError((error) => Option.match(decodeExited(error), { onNone: () => Console.error(`restart-leg: ${String(error)}`), onSome: () => Effect.void })),
      Effect.provide(live),
    ),
    { disableErrorReporting: true, teardown: (exit, onExit) => onExit(exitCodeOf(exit)) },
  )

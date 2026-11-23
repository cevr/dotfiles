// `bun scripts/chrome.ts launch [--dir <run dir>] [--port N] [--resolver-rules R] [--proxy P] [--shell] -- <flags>`:
// the one way an agent starts a Chrome of its own for the DevTools protocol, on the Mac or Linux.
//
// The Chrome is always headless and always off the login keychain: `--use-mock-keychain` (macOS: Chrome keeps its
// Safe Storage key in memory and never asks the keychain, so no "wants to use your confidential information" dialog
// reaches the owner's screen) and `--password-store=basic` (Linux: no GNOME keyring or KWallet; inert on macOS). Both
// go after the caller's flags, and a caller's flag that would replace or drop either (another `--use-mock-keychain…`
// or `--password-store…`, a bare `--` after which Chromium reads no switch) is refused, as are the switches the
// launcher owns (`--user-data-dir`, `--headless`, `--remote-debugging-*`).
//
// The profile is a fresh folder the launcher makes, under `--dir` (the caller's run directory) or the system's temp
// directory, never the owner's: `<folder>/profile`, with `<folder>/launch.json` recording the launch and
// `<folder>/chrome.log` Chrome's output. The browser is Chrome for Testing from Playwright's cache (newest first),
// then agent-browser's, then Playwright's headless shell (`--shell` puts the shell first); never the owner's Google
// Chrome. `launch` prints one JSON line, `{ endpoint, port, pid, folder, binary }`, the endpoint the browser's
// DevTools WebSocket once the browser this launch started answers on loopback at its port (`--port N`, or for 0 the
// one Chrome chose; another process on that port fails the launch and is left alone), and leaves Chrome running in a process group of its own; `stop <pid>` ends that group and
// removes the folder, and refuses a pid that is not a Chrome this launcher started.
//
// As a library: `chromeArgs` (the argument list, refusing what it must), `findChrome`, `start`, `stop`, and `launch`,
// a scoped start that stops at the scope's end. The guard (mods/guard/chrome.ts) and the lint
// (lint/chrome-keychain.ts) send every other headless or DevTools launch here.
//
// Exit: 0 done, 1 refused or failed (the reason on stderr).
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { file, spawn, spawnSync, which } from "bun"
import { Array as Arr, Config, Console, Data, Duration, Effect, Exit, FileSystem, Match, Option, Order, Result, Schedule, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient } from "effect/http"

/** The flags that keep a Chrome off the login keychain, last on its command line. */
export const KEYCHAIN_FLAGS = ["--use-mock-keychain", "--password-store=basic"] as const

/** The switches the launcher owns, which a caller's flag may not set (without its dashes). */
const OWNED = ["use-mock-keychain", "password-store", "user-data-dir", "headless", "remote-debugging-"] as const

/** How long Chrome has to open its DevTools port before the launch fails. */
const READY = Duration.seconds(20)

/** How long a stopped Chrome has to end on SIGTERM before it gets SIGKILL. */
const ENDING = Duration.seconds(5)

/** A launch refused or failed, with the reason the caller reads. */
export class ChromeError extends Data.TaggedError("ChromeError")<{ readonly message: string }> {}

/** Which browser a launch prefers. */
export type Prefer = "testing" | "shell"

/** What a launch asks for: the caller's flags, the port (0 any free one), Chrome's host resolver rules and proxy. */
export interface Options {
  readonly flags: ReadonlyArray<string>
  readonly port: number
  readonly resolverRules: Option.Option<string>
  readonly proxy: Option.Option<string>
}

/** Options with nothing asked: any free port, no flags. */
export const DEFAULTS: Options = { flags: [], port: 0, resolverRules: Option.none(), proxy: Option.none() }

/** Why a caller's flag is refused, if it is: a bare `--`, or a switch the launcher owns, however many dashes it has. */
const refusalOf = (flag: string): Option.Option<string> => {
  if (flag === "--") return Option.some("`--` ends Chrome's switches, so the keychain flags after it would be read as pages")
  const name = flag.replace(/^-+/, "")
  return Option.map(
    Arr.findFirst(OWNED, (owned) => flag.startsWith("-") && name.startsWith(owned)),
    (owned) => `\`${flag}\` sets --${owned}, which the launcher owns`,
  )
}

/**
 * Chrome's argument list for a profile at `profile`: headless, the caller's flags, then the switches the launcher
 * owns and the keychain flags last (Chromium reads the last copy of a switch), and a blank page. Fails naming each
 * caller's flag it refuses.
 */
export const chromeArgs = (options: Options, profile: string): Result.Result<ReadonlyArray<string>, string> => {
  const refused = options.flags.flatMap((flag) => Option.toArray(refusalOf(flag)))
  if (refused.length > 0) return Result.fail(`refused: ${refused.join("; ")}`)
  return Result.succeed([
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    ...Option.toArray(Option.map(options.resolverRules, (rules) => `--host-resolver-rules=${rules}`)),
    ...Option.toArray(Option.map(options.proxy, (proxy) => `--proxy-server=${proxy}`)),
    ...options.flags,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${options.port}`,
    ...KEYCHAIN_FLAGS,
    "about:blank",
  ])
}

/** Where the browsers live: Playwright's cache and agent-browser's. */
export interface Places {
  readonly playwright: string
  readonly agentBrowser: string
}

/** The browsers' homes on this host: `PLAYWRIGHT_BROWSERS_PATH`, else Playwright's cache by platform; `~/.agent-browser/browsers`. */
export const placesOf = Effect.fn("Chrome.placesOf")(function* () {
  const home = yield* Config.String("HOME")
  const cache = Option.match(Option.liftPredicate(process.platform, (platform) => platform === "darwin"), {
    onSome: () => `${home}/Library/Caches/ms-playwright`,
    onNone: () => `${home}/.cache/ms-playwright`,
  })
  const playwright = yield* Config.String("PLAYWRIGHT_BROWSERS_PATH").pipe(Config.withDefault(cache))
  return { playwright, agentBrowser: `${home}/.agent-browser/browsers` } satisfies Places
})

/** A browser on disk: its program, and whether it is the headless shell. */
export interface Binary {
  readonly path: string
  readonly shell: boolean
}

/** Chrome for Testing's program inside a version folder, on macOS and Linux. */
const TESTING = ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome"] as const

/** The number a versioned folder ends with (`chromium-1255`, `chrome-149.0.7827.55`): the newest sorts first. */
const versionOf = (name: string): ReadonlyArray<number> => name.replace(/^[^0-9]*/, "").split(".").map(Number)

const newestFirst = Order.flip(Order.Array(Order.Number))

/** The folders under `root` named `prefix…`, newest first; none when `root` cannot be read. */
const versions = Effect.fn("Chrome.versions")(function* (root: string, prefix: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  const matching = names.filter((name) => name.startsWith(prefix) && /[0-9]/.test(name.slice(prefix.length, prefix.length + 1)))
  return Arr.sort(matching, Order.mapInput(newestFirst, versionOf)).map((name) => `${root}/${name}`)
})

/** The platform folders inside a version folder (`chrome-mac-arm64`, `chrome-linux64`), or the folder itself. */
const platformDirs = Effect.fn("Chrome.platformDirs")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  return [dir, ...names.filter((name) => name.startsWith("chrome-")).map((name) => `${dir}/${name}`)]
})

/** Every browser the launcher may start, in its order of preference. */
export const browsersIn = Effect.fn("Chrome.browsersIn")(function* (places: Places, prefer: Prefer) {
  const fs = yield* FileSystem.FileSystem
  const inside = (dirs: ReadonlyArray<string>, programs: ReadonlyArray<string>) =>
    Effect.forEach(dirs, (dir) => Effect.map(platformDirs(dir), (each) => each.flatMap((at) => programs.map((program) => `${at}/${program}`))))
  const testing = [
    ...(yield* inside(yield* versions(places.playwright, "chromium-"), TESTING)).flat(),
    ...(yield* inside(yield* versions(places.agentBrowser, "chrome-"), TESTING)).flat(),
  ]
  const shells = (yield* inside(yield* versions(places.playwright, "chromium_headless_shell-"), ["chrome-headless-shell"])).flat()
  const exists = (path: string) => Effect.map(fs.stat(path), (info) => info.type === "File").pipe(Effect.orElseSucceed(() => false))
  const found = {
    testing: (yield* Effect.filter(testing, exists)).map((path): Binary => ({ path, shell: false })),
    shell: (yield* Effect.filter(shells, exists)).map((path): Binary => ({ path, shell: true })),
  }
  return Option.match(Option.liftPredicate(prefer, (each) => each === "shell"), {
    onSome: () => [...found.shell, ...found.testing],
    onNone: () => [...found.testing, ...found.shell],
  })
})

/** The browser the launcher starts on this host, or a failure naming where it looked. */
export const findChrome = Effect.fn("Chrome.findChrome")(function* (prefer: Prefer) {
  const places = yield* placesOf()
  const found = Arr.head(yield* browsersIn(places, prefer))
  if (Option.isNone(found))
    return yield* new ChromeError({
      message: `no Chrome for Testing or headless shell in ${places.playwright} or ${places.agentBrowser}: run \`bunx playwright install chromium\` or \`agent-browser install\``,
    })
  return found.value
})

/** What a running launch is: its DevTools WebSocket, port, pid, folder and browser. */
export const Launched = Schema.Struct({ endpoint: Schema.String, port: Schema.Number, pid: Schema.Number, folder: Schema.String, binary: Schema.String })
export type Launched = typeof Launched.Type
const LaunchedJson = Schema.fromJsonString(Launched)
const encodeLaunched = Schema.encodeSync(LaunchedJson)
const decodeLaunched = Schema.decodeUnknownOption(LaunchedJson)

/** Where a launch keeps things: its folder, the profile in it, the record and Chrome's output. */
const layoutOf = (folder: string) => ({ folder, profile: `${folder}/profile`, record: `${folder}/launch.json`, log: `${folder}/chrome.log` })

/** The DevTools port file Chrome writes in its profile: the port, then the browser's WebSocket path. */
const endpointOf = (text: string): Option.Option<{ readonly port: number; readonly path: string }> => {
  const [port = "", path = ""] = text.split("\n")
  return Option.map(
    Option.liftPredicate(Number(port), (each) => Number.isInteger(each) && each > 0 && path.startsWith("/")),
    (each) => ({ port: each, path }),
  )
}

/** Whether `pid` is a live process, by `ps`; its command line when it is. */
const commandOf = (pid: number): Option.Option<string> => {
  const out = spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  return Option.liftPredicate(out.stdout.toString().trim(), (each) => out.exitCode === 0 && each !== "")
}

/** Sends `signal` to the process group `pid` leads, through kill(1). */
const signalGroup = (pid: number, signal: "TERM" | "KILL") => spawnSync(["/bin/kill", `-${signal}`, "--", `-${pid}`], { stdout: "ignore", stderr: "ignore" })

/** Where lsof lives (macOS /usr/sbin, Linux /usr/bin), searched whatever the caller's PATH holds. */
const LSOF_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"

/** The pids that listen on TCP `port`, on any address, by lsof; a failure when lsof is missing. */
const listenersOf = (port: number): Result.Result<ReadonlyArray<number>, string> =>
  Option.match(Option.fromNullishOr(which("lsof", { PATH: LSOF_PATH })), {
    onNone: () => Result.fail(`no lsof in ${LSOF_PATH}: cannot tell which process holds port ${port}`),
    onSome: (lsof) => {
      const out = spawnSync([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" })
      return Result.succeed(out.stdout.toString().split("\n").filter((line) => /^\d+$/.test(line)).map(Number))
    },
  })

/** How the refusal names the processes holding a port: each pid with its command. */
const holders = (pids: ReadonlyArray<number>): string =>
  pids.map((pid) => `pid ${pid} (${Option.getOrElse(commandOf(pid), () => "gone").slice(0, 120)})`).join(", ")

/** Not ready yet: the port file, the endpoint or the listening socket is not there. */
class NotYet extends Data.TaggedError("NotYet")<{}> {}

/** What `/json/version` answers: the browser's WebSocket. */
const decodeVersion = Schema.decodeUnknownOption(Schema.Struct({ webSocketDebuggerUrl: Schema.String }))

/** The WebSocket path `/json/version` names on loopback `port`; NotYet while nothing answers there. */
const versionPath = (port: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* client.get(`http://127.0.0.1:${port}/json/version`).pipe(Effect.flatMap((response) => response.json), Effect.timeout(Duration.seconds(1)))
    return yield* Effect.fromOption(Option.flatMap(decodeVersion(body), (version) => Option.fromNullishOr(/^ws:\/\/[^/]+(\/.+)$/.exec(version.webSocketDebuggerUrl)?.[1])))
  }).pipe(
    Effect.mapError(() => new NotYet()),
    Effect.provide(FetchHttpClient.layer),
  )

/**
 * The endpoint of the browser `pid` once it answers DevTools on loopback: at the port Chrome wrote to its profile's
 * `DevToolsActivePort` when the launch asked for any free port (0), else at the port it asked for (Chrome writes no
 * file then). Either way it is this launch's browser only when `pid` itself listens on that port: an answer from
 * another process there fails with its pid, and is never adopted. NotYet until then.
 */
const readiness = (pid: number, asked: number, profile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const port = yield* Option.match(Option.liftPredicate(asked, (each) => each > 0), {
      onSome: (fixed) => Effect.succeed(fixed),
      onNone: () =>
        fs.readFileString(`${profile}/DevToolsActivePort`).pipe(
          Effect.mapError(() => new NotYet()),
          Effect.flatMap((text) => Effect.fromOption(Option.map(endpointOf(text), (each) => each.port))),
          Effect.mapError(() => new NotYet()),
        ),
    })
    const path = yield* versionPath(port)
    const listeners = listenersOf(port)
    if (Result.isFailure(listeners)) return yield* new ChromeError({ message: listeners.failure })
    if (listeners.success.includes(pid)) return { port, path }
    if (listeners.success.length > 0) return yield* new ChromeError({ message: `port ${port} answers DevTools from another process, ${holders(listeners.success)}, not this launch's browser` })
    return yield* new NotYet()
  })

/**
 * Starts Chrome under a fresh folder in `dir` (the system's temp directory when none) and leaves it running in a
 * process group of its own. Ready when that browser answers DevTools on loopback at the port it was given or chose
 * (`readiness`). Fails at once when a flag is refused or a fixed port is already held, before anything starts;
 * fails, ending only the browser it started and removing its folder, when that browser ends, another process
 * answers on its port, or it is not ready in time.
 */
export const start = Effect.fn("Chrome.start")(function* (options: Options, dir: Option.Option<string>, binary: Binary) {
  const fs = yield* FileSystem.FileSystem
  const made = yield* Option.match(dir, {
    onNone: () => fs.makeTempDirectory({ prefix: "chrome-" }),
    onSome: (directory) => fs.makeDirectory(directory, { recursive: true }).pipe(Effect.andThen(fs.makeTempDirectory({ directory, prefix: "chrome-" }))),
  }).pipe(Effect.mapError((error) => new ChromeError({ message: `cannot make the profile folder: ${error.message}` })))
  const at = layoutOf(made)
  const removeFolder = fs.remove(at.folder, { recursive: true }).pipe(Effect.ignore)
  const args = chromeArgs(options, at.profile)
  if (Result.isFailure(args)) return yield* removeFolder.pipe(Effect.andThen(new ChromeError({ message: args.failure })))
  if (options.port > 0) {
    // A fixed port another process holds: fail before starting anything, and leave that process alone.
    const held = Result.getOrElse(listenersOf(options.port), () => [])
    if (held.length > 0) return yield* removeFolder.pipe(Effect.andThen(new ChromeError({ message: `port ${options.port} is in use by ${holders(held)}: pick another --port, or 0 for any free one` })))
  }
  const child = spawn([binary.path, ...args.success], { detached: true, stdin: "ignore", stdout: file(at.log), stderr: file(at.log) })
  child.unref()
  const pid = child.pid
  const failed = (message: string) => Effect.sync(() => signalGroup(pid, "KILL")).pipe(Effect.andThen(removeFolder), Effect.andThen(new ChromeError({ message })))
  const opened = readiness(pid, options.port, at.profile).pipe(
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: Duration.toMillis(READY) / 100, while: (error) => error._tag === "NotYet" }),
    Effect.timeoutOption(READY),
    Effect.catchTag("NotYet", () => Effect.succeed(Option.none<{ readonly port: number; readonly path: string }>())),
  )
  // A browser that ends before it opens its port fails the launch at once.
  const port = yield* Effect.raceFirst(opened, Effect.promise(() => child.exited).pipe(Effect.as(Option.none()))).pipe(
    Effect.catchTag("ChromeError", (error) => failed(error.message)),
  )
  if (Option.isNone(port)) {
    const log = yield* fs.readFileString(at.log).pipe(Effect.orElseSucceed(() => ""))
    return yield* failed(`${binary.path} opened no DevTools port within ${Duration.format(READY)}: ${log.trim().split("\n").slice(-5).join(" | ")}`)
  }
  const launched: Launched = { endpoint: `ws://127.0.0.1:${port.value.port}${port.value.path}`, port: port.value.port, pid, folder: at.folder, binary: binary.path }
  yield* fs.writeFileString(at.record, encodeLaunched(launched)).pipe(Effect.catch((error) => failed(`cannot write ${at.record}: ${error.message}`)))
  return launched
})

/** The folder of the launch `pid` runs, read from its command line and confirmed by the record in it. */
const folderOf = Effect.fn("Chrome.folderOf")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem
  const notOurs = (why: string) => new ChromeError({ message: `pid ${pid} is not a Chrome scripts/chrome.ts started: ${why}` })
  const command = commandOf(pid)
  if (Option.isNone(command)) return yield* notOurs("no such process")
  const folder = Option.flatMap(Option.fromNullishOr(/--user-data-dir=(.+?)\/profile --remote-debugging-port=/.exec(command.value)), (match) => Option.fromUndefinedOr(match[1]))
  if (Option.isNone(folder) || !command.value.includes(KEYCHAIN_FLAGS.join(" "))) return yield* notOurs("its command line is not the launcher's")
  const record = decodeLaunched(yield* fs.readFileString(layoutOf(folder.value).record).pipe(Effect.orElseSucceed(() => "")))
  if (Option.isNone(record) || record.value.pid !== pid) return yield* notOurs(`${folder.value} holds no record of it`)
  return folder.value
})

/** Ends the launch `pid` runs (SIGTERM to its group, SIGKILL after `ENDING`) and removes its folder. */
export const stop = Effect.fn("Chrome.stop")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem
  const folder = yield* folderOf(pid)
  signalGroup(pid, "TERM")
  const ended = yield* Effect.sync(() => Option.isNone(commandOf(pid))).pipe(
    Effect.repeat({ schedule: Schedule.spaced(Duration.millis(100)), until: (gone) => gone }),
    Effect.timeoutOption(ENDING),
  )
  if (Option.isNone(ended)) signalGroup(pid, "KILL")
  yield* fs.remove(folder, { recursive: true }).pipe(Effect.ignore)
  return folder
})

/** A Chrome for the scope's life: started as `start` does, stopped (its group ended, its folder removed) at the end. */
export const launch = (options: Options, dir: Option.Option<string>, binary: Binary) =>
  Effect.acquireRelease(start(options, dir, binary), (launched) => stop(launched.pid).pipe(Effect.ignore))

const launchCommand = Command.make(
  "launch",
  {
    dir: Flag.String("dir").pipe(Flag.withDescription("The run directory the profile folder goes under (default: the temp directory)"), Flag.optional),
    port: Flag.Int("port").pipe(Flag.withDescription("The DevTools port (0: any free one)"), Flag.withDefault(0)),
    resolverRules: Flag.String("resolver-rules").pipe(Flag.withDescription("Chrome's --host-resolver-rules"), Flag.optional),
    proxy: Flag.String("proxy").pipe(Flag.withDescription("Chrome's --proxy-server"), Flag.optional),
    shell: Flag.Boolean("shell").pipe(Flag.withDescription("Prefer Playwright's headless shell to Chrome for Testing"), Flag.withDefault(false)),
    flags: Argument.String("flags").pipe(Argument.withDescription("Chrome flags after `--`"), Argument.variadic()),
  },
  Effect.fn("Chrome.launchCommand")(function* (input) {
    const prefer: Prefer = Option.match(Option.liftPredicate(input.shell, Boolean), { onSome: () => "shell", onNone: () => "testing" })
    const binary = yield* findChrome(prefer)
    const options: Options = { flags: input.flags, port: input.port, resolverRules: input.resolverRules, proxy: input.proxy }
    const launched = yield* start(options, input.dir, binary)
    yield* Console.log(encodeLaunched(launched))
  }),
).pipe(Command.withDescription("Start a headless Chrome off the login keychain; print its DevTools endpoint and pid"))

const stopCommand = Command.make(
  "stop",
  { pid: Argument.Int("pid").pipe(Argument.withDescription("The pid `launch` printed")) },
  Effect.fn("Chrome.stopCommand")(function* (input) {
    const folder = yield* stop(input.pid)
    yield* Console.log(`stopped ${input.pid}, removed ${folder}`)
  }),
).pipe(Command.withDescription("End a Chrome `launch` started and remove its folder"))

const command = Command.make("chrome").pipe(Command.withSubcommands([launchCommand, stopCommand]))

if (import.meta.main)
  BunRuntime.runMain(
    Command.run(command, { version: "1.0.0" }).pipe(
      Effect.tapError((error) => Console.error(`chrome: ${Match.value(error).pipe(Match.tag("ChromeError", (refused) => refused.message), Match.orElse(String))}`)),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true, teardown: (exit, onExit) => onExit(Exit.match(exit, { onSuccess: () => 0, onFailure: () => 1 })) },
  )

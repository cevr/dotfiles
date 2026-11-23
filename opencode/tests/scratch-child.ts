import { gunzipSync, spawn, spawnSync } from "bun"
import { Data, Option, Predicate } from "effect"
import { ChildProcess } from "effect/process"
import { ROOT } from "../scripts/reach.ts"
import { cloneGitArgv, initGitArgv, QUIET_GIT, type GitEnv } from "./git-repo.ts"
import { externalInput, matchingInput, scratchInput } from "./read-path.ts"
import { localTestPaths, localTestProcess, scratchRoot } from "./scratch.ts"

const { resolve } = localTestPaths
const checkout = resolve(ROOT, "..")
const physicalCheckout = localTestPaths.realpathSync(checkout)
const gitCommands = new Set([
  "add", "branch", "check-attr", "checkout", "commit", "init", "log", "merge", "merge-base", "rev-list", "rev-parse", "status", "update-ref",
])
const gitIdentity = /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|LANG|LC_[A-Z_]+)$/
const marker = "TEST_READS_SCRATCH_CHILD"
const systemPath = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]

class ScratchChildInput extends Data.TaggedError("ScratchChildInput")<{ readonly message: string }> {}

const reject = (reason: string) =>
  Option.getOrThrowWith(Option.none<never>(), () => new ScratchChildInput({ message: `scratch child: ${reason}` }))

const containsCheckout = (text: string) => text.includes(checkout) || text.includes(physicalCheckout)
const searchPath = () => systemPath.filter((item) => {
  if (!localTestPaths.existsSync(item) || containsCheckout(localTestPaths.realpathSync(item))) return false
  const git = resolve(item, "git")
  return !localTestPaths.existsSync(git) || !containsCheckout(localTestPaths.realpathSync(git))
}).join(":")

const isEntryName = (entry: string) => /^(?:[\w-]+\/)+[\w.-]+\.[cm]?[jt]sx?$/.test(entry)
const loaderVariable = /^(?:BASH|BUN|DYLD|ENV|LD_|NODE|SHELL|ZDOTDIR)/
const bunStatePaths = ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
const fixtureFlag = (name: string, value: string) => {
  if (name === "OPENCODE_FLAGS") return /^(?:-?[\w]+)(?:,-?[\w]+)*$/.test(value)
  if (name === "GAMUT_OWNER") return /^[1-9]\d{0,9}$/.test(value) && Number(value) > 1
  return ["OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_FREE_MODELS"].includes(name) && value === "1"
}

interface FixtureEnvironment {
  readonly scratch: Readonly<Record<string, string>>
  readonly external: Readonly<Record<string, string>>
  readonly checkout?: Readonly<Record<string, string>>
  readonly values: Readonly<Record<string, string>>
  readonly scratchArgs?: ReadonlyArray<string>
  /** A scratch directory containing only one validated external work executable. */
  readonly workBinDir?: string
}

export const checkoutBun = (entry: string, inputs: FixtureEnvironment) => {
  if (!isEntryName(entry)) return reject(`not a checkout entry: ${entry}`)
  const bunDir = resolve(localTestProcess.execPath, "..")
  if (containsCheckout(bunDir) || containsCheckout(localTestPaths.realpathSync(bunDir))) return reject("checkout directory on the fixture PATH")
  const path = [bunDir, searchPath()]
  if (inputs.workBinDir) {
    const dir = scratchInput(inputs.workBinDir)
    if (!exactArgs(localTestPaths.readdirSync(dir), "work")) return reject("expected one staging entry named work")
    externalInput(resolve(dir, "work"))
    path.unshift(dir)
    // Work reads the platform's mount table before allowing a copy-on-write clone.
    path.push("/sbin")
  }
  const env = new Map<string, string>([["PATH", path.join(":")]])
  const put = (name: string, value: string) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || loaderVariable.test(name) || env.has(name))
      return reject(`unsupported checkout fixture environment: ${name}`)
    env.set(name, value)
  }
  for (const [key, file] of Object.entries(inputs.scratch)) put(key, scratchInput(file))
  for (const [key, file] of Object.entries(inputs.external)) put(key, externalInput(file))
  for (const [key, file] of Object.entries(inputs.checkout || {})) put(key, matchingInput(file))
  for (const [key, value] of Object.entries(inputs.values)) {
    if (!fixtureFlag(key, value)) return reject(`unsupported checkout fixture flag: ${key}`)
    put(key, value)
  }
  for (const name of bunStatePaths)
    if (!Object.hasOwn(inputs.scratch, name)) return reject(`missing scratch fixture environment: ${name}`)
  const argv: [string, ...Array<string>] = [localTestProcess.execPath, "--no-env-file", matchingInput(entry), ...(inputs.scratchArgs ?? []).map(scratchInput)]
  return { argv, cwd: ROOT, env: Object.fromEntries(env) }
}

/** A fixed local Bun entry, with each generated, pinned and checkout input checked before launch. */
export const checkoutBunCommand = (
  entry: string, inputs: FixtureEnvironment, lifecycle: Pick<ChildProcess.CommandOptions, "detached" | "stdout" | "stderr" | "forceKillAfter"> = {},
) => {
  const { argv: [bun, ...args], ...options } = checkoutBun(entry, inputs)
  return ChildProcess.make(bun, args, {
    ...options, extendEnv: false, stdin: "ignore", forceKillAfter: lifecycle.forceKillAfter || "3 seconds",
    detached: lifecycle.detached, stdout: lifecycle.stdout, stderr: lifecycle.stderr,
  })
}

/** The same checked entry for Bun tests that own their subprocess lifecycle. */
export const spawnCheckoutBun = (entry: string, inputs: FixtureEnvironment, detached = false) => {
  const { argv, ...options } = checkoutBun(entry, inputs)
  return spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached })
}

export const spawnCheckoutBunSync = (entry: string, inputs: FixtureEnvironment) => {
  const { argv, ...options } = checkoutBun(entry, inputs)
  return spawnSync(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

interface CheckoutTestInputs {
  readonly temp: string
  readonly state: string
  readonly timeout?: number
  readonly filter?: string
  readonly fork?: string
  readonly checkout?: Readonly<Record<"OPENCODE_RECONNECT_TUI_BINARY", string>>
}

/** Explicit nested test files, not Bun's checkout test discovery. */
export const checkoutTests = (input: CheckoutTestInputs, ...entries: ReadonlyArray<string>) => {
  const { temp, state, timeout, filter, fork } = input
  if (entries.length === 0 || new Set(entries).size !== entries.length || entries.some((entry) => !isEntryName(entry)))
    return reject("nested test launch needs distinct checkout entries")
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 300_000))
    return reject("invalid nested test timeout")
  if (filter !== undefined && !/^[\w ^$.-]+$/.test(filter)) return reject("unsupported nested test filter")
  if (input.checkout && !exactArgs(Object.keys(input.checkout), "OPENCODE_RECONNECT_TUI_BINARY"))
    return reject("unsupported nested test checkout environment")
  const env: Record<string, string> = {
    ...checkoutBun(entries[0]!, {
      scratch: {
        HOME: state, TMPDIR: temp, XDG_CONFIG_HOME: resolve(state, "config"), XDG_CACHE_HOME: resolve(state, "cache"),
        XDG_STATE_HOME: resolve(state, "state"), XDG_DATA_HOME: resolve(state, "data"),
      },
      external: fork ? { OPENCODE_DEV: fork } : {},
      checkout: input.checkout, values: {},
    }).env,
    ...(fork ? {} : { OPENCODE_DEV: "" }),
    // Keep Bun's own cache out of the caller's TMPDIR leak detector.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
  const data = resolve(state, "data")
  if (localTestPaths.existsSync(data) && localTestPaths.readdirSync(data).length !== 0)
    return reject("nested test XDG data must be empty")
  const files = entries.map((entry) => `./${localTestPaths.relative(ROOT, matchingInput(entry))}`)
  return {
    argv: [localTestProcess.execPath, "--no-env-file", "test", ...(timeout ? ["--timeout", String(timeout)] : []),
      ...(filter ? ["-t", filter] : []), ...files],
    cwd: ROOT, env,
  }
}

/** The reaper fixture inspects one process, not the checkout it may be running in. */
export const reaperEnvironment = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return reject("invalid reaper process ID")
  return ChildProcess.make("/bin/ps", ["eww", "-o", "command=", "-p", `${pid}`], {
    extendEnv: false, env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second",
  })
}

/** Real child lifecycles for the reaper: background, own group, and a child that replaces itself. */
export const reaperChild = (kind: "daemon" | "child" | "respawner", seen: string) => {
  const file = scratchInput(seen)
  const cwd = resolve(file, "..")
  const options = { cwd, env: { ...scratchPtyEnv(cwd), REAPER_SEEN: file }, extendEnv: false, stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second" } as const
  switch (kind) {
    case "daemon":
      return ChildProcess.make("/bin/sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!; sleep 1"], options)
    case "child":
      return ChildProcess.make("/bin/sleep", ["121"], { ...options, detached: true, stdout: "ignore" })
    case "respawner":
      return ChildProcess.make("/bin/sh", ["-c", `trap 'sleep 122 & echo $! >"$REAPER_SEEN.respawned"; exit' TERM; while :; do sleep 1; done`], { ...options, detached: true, stdout: "ignore" })
  }
}

/** Launch a named checkout entry behind a short-lived shim; the child gets the shim's parent PID. */
export const detachedCheckoutBun = (
  entry: string, parentVariable: string, pathVariables: ReadonlyArray<readonly [string, string]> = [],
) => {
  const safeName = /^[A-Z][A-Z0-9_]*$/
  if (!isEntryName(entry)) return reject(`not a checkout entry: ${entry}`)
  if (!safeName.test(parentVariable) || /^(?:BUN|DYLD|LD_|NODE|PATH|HOME|XDG|SHELL|TMPDIR|ZDOTDIR)/.test(parentVariable))
    return reject(`unsupported parent PID variable: ${parentVariable}`)
  const program = matchingInput(entry)
  const root = scratchRoot()
  // Fixtures can inspect this TMPDIR for leaks; a detached reaper must not leave a transpiler cache there.
  const base = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
  for (const [name, value] of pathVariables) {
    if (!safeName.test(name) || name in base || name === parentVariable || /^(?:BASH|BUN|ENV|LD_|DYLD|NODE|ZDOTDIR)/.test(name))
      return reject(`redirecting Bun fixture environment: ${name}`)
    scratchInput(value)
  }
  return ChildProcess.make("/bin/sh", ["-c", `${parentVariable}=$PPID "$1" --no-env-file "$0" </dev/null >/dev/null 2>&1 &`, program, localTestProcess.execPath], {
    cwd: ROOT, env: { ...Object.fromEntries(pathVariables), ...base }, extendEnv: false,
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second",
  })
}

const servicePathVariables = new Set([
  "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "TMPDIR",
])
const serviceValues = new Set([
  "PATH", "TERM", "HERDR_ENV", "OPENCODE_PASSWORD", "OPENCODE_DISABLE_FREE_MODELS", "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_FILEWATCHER", "OPENCODE_FLAGS", "BUN_OPTIONS", "OPENCODE_PRINT_LOGS", "ANTHROPIC_BASE_URL",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "OPENCODE_CLI_CONFIG_CONTENT",
])
const exactArgs = (given: ReadonlyArray<string>, ...expected: ReadonlyArray<string>) =>
  given.length === expected.length && given.every((arg, index) => arg === expected[index])
const loopback = (url: string) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(url)
const remoteTuiArgs = (args: ReadonlyArray<string>) => {
  const [flag, url, session, id] = args
  if (flag !== "--server" || !loopback(url || "")) return false
  return args.length === 2 || (args.length === 4 && session === "-s" && /^ses_[\w-]+$/.test(id || ""))
}
const forkArgsAllowed = (args: ReadonlyArray<string>) => {
  const [command, verb, field, value] = args
  switch (command) {
    case "service":
      return (args.length === 2 && ["start", "stop", "restart"].includes(verb || "")) ||
        (args.length === 4 && verb === "set" && field === "port" && /^\d{1,5}$/.test(value || ""))
    case "serve": return exactArgs(args, "serve", "--service", "--port", "0")
    case "auth": return exactArgs(args, "auth", "import", "--standalone")
    case "run": return exactArgs(args, "run", "--standalone", "--dangerously-skip-permissions", "--format", "json", "say hello")
    case "--server": return remoteTuiArgs(args)
    default: return false
  }
}

const forkVersionOption = (version: string) => {
  if (!/^\d+\.\d+\.\d+-prime\.[a-f0-9]{8}\.[a-f0-9]{8}$/.test(version)) return reject("invalid fixture version")
  return `--define=OPENCODE_VERSION:"${version}"`
}

const checkForkBunOptions = (env: Readonly<Record<string, string>>, preload: string, version?: string) => {
  const option = (value?: string) => {
    if (value) return ` ${forkVersionOption(value)}`
    return ""
  }
  if (env.BUN_OPTIONS !== `--conditions=browser --preload=${preload}${option(version)}` ||
      (Object.hasOwn(env, "BUN_RUNTIME_TRANSPILER_CACHE_PATH") && env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0"))
    return reject("unexpected Bun fixture options")
}

const checkForkEnvironment = (env: Readonly<Record<string, string>>) => {
  for (const variable of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB"]) {
    const path = env[variable]
    if (!path) return reject(`missing fork fixture environment: ${variable}`)
  }
  for (const [name, value] of Object.entries(env)) {
    if (containsCheckout(value) || (!servicePathVariables.has(name) && !serviceValues.has(name)))
      return reject(`redirecting fork fixture environment: ${name}`)
    if (servicePathVariables.has(name)) scratchInput(value)
  }
  if (env.ANTHROPIC_BASE_URL && !loopback(env.ANTHROPIC_BASE_URL))
    return reject("fixture API must be on loopback")
  if (Object.hasOwn(env, "OPENCODE_CLI_CONFIG_CONTENT") && !/^\s*\{\s*"plugins"\s*:\s*\[\s*\]\s*\}\s*$/.test(env.OPENCODE_CLI_CONFIG_CONTENT || ""))
    return reject("only a plugin-free CLI fixture may be supplied as inline config")
}

/** A fixed CLI mode from the pinned external fork with scratch state and a checked preload. */
export const forkFixture = (
  fork: string, cwd: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>>,
  version?: string,
) => {
  if (!forkArgsAllowed(args)) return reject("unsupported external fork fixture command")
  const entry = externalInput(resolve(fork, "packages/cli/src/index.ts"))
  const preload = externalInput(resolve(fork, "packages/tui/node_modules/@opentui/solid/scripts/preload.js"))
  checkForkBunOptions(env, preload, version)
  checkForkEnvironment(env)
  const path = resolve(localTestProcess.execPath, "..")
  if (containsCheckout(path) || containsCheckout(localTestPaths.realpathSync(path))) return reject("checkout directory on the fixture PATH")
  return {
    argv: [localTestProcess.execPath, "--no-env-file", entry, ...args] as const, cwd: scratchInput(cwd),
    env: { TMPDIR: scratchRoot(), ...env, PATH: `${path}:${searchPath()}` },
  }
}

/** Interactive fork entry, with only the default screen or one session ID allowed. */
export const forkTuiFixture = (
  fork: string, cwd: string, env: Readonly<Record<string, string>>,
  move?: { readonly installed: string; readonly own: string; readonly session: string },
) => {
  const { argv: [bun, noEnv, entry], ...options } = forkFixture(fork, cwd, ["service", "start"], env, move?.installed)
  if (!move) return { ...options, command: [bun, noEnv, entry] as const }
  if (!/^ses_[\w-]+$/.test(move.session)) return reject("invalid fork fixture session")
  return { ...options, command: [bun, noEnv, forkVersionOption(move.own), entry, "-s", move.session] as const }
}

/** Drive's two scenario modes, with a fixed checkout script and generated local state. */
export const driveScenarioFixture = (entry: string, output: string, fork: string, name = "") => {
  if (name && !/^[a-z][a-z0-9-]*$/.test(name)) return reject("invalid drive fixture name")
  const script = matchingInput("scenarios/**/*.ts", entry)
  const out = scratchInput(output)
  const dev = externalInput(fork)
  const bun = localTestProcess.execPath
  const bin = resolve(bun, "..")
  if (containsCheckout(bin) || containsCheckout(localTestPaths.realpathSync(bin))) return reject("checkout directory on the fixture PATH")
  const env = {
    PATH: `${bin}:${searchPath()}`, OPENCODE_DEV: dev, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: scratchInput(resolve(out, "media")),
    HOME: out, TMPDIR: scratchRoot(), XDG_CONFIG_HOME: scratchInput(resolve(out, "config")),
    XDG_DATA_HOME: scratchInput(resolve(out, "data")), XDG_STATE_HOME: scratchInput(resolve(out, "state")),
    XDG_CACHE_HOME: scratchInput(resolve(out, "cache")),
  }
  const prefix = [bun, "--no-env-file", "x", "opencode-drive"]
  if (!name) return { argv: [...prefix, "run", script], cwd: ROOT, env }
  const db = scratchInput(resolve(out, "opencode.db"))
  if (localTestPaths.existsSync(db) || localTestPaths.existsSync(env.XDG_DATA_HOME)) return reject("drive fixture data directory is not fresh")
  return { argv: [...prefix, "start", "--name", name, "--dev", dev, "--script", script], cwd: ROOT, env: { ...env, OPENCODE_DRIVE_DB: db } }
}

export const forkProcessCommand = (
  input: Parameters<typeof forkFixture>, io?: Pick<ChildProcess.CommandOptions, "stdin" | "stdout" | "stderr">,
) => {
  const { argv: [bun, ...args], ...options } = forkFixture(...input)
  return ChildProcess.make(bun, args, {
    ...options, extendEnv: false, stdin: io?.stdin ?? "ignore", stdout: io?.stdout ?? "pipe", stderr: io?.stderr ?? "pipe", forceKillAfter: "3 seconds",
  })
}

export const forkServiceCommand = (...input: Parameters<typeof forkFixture>) => forkProcessCommand(input)

export const spawnForkFixture = (...input: Parameters<typeof forkFixture>) => {
  const { argv, ...options } = forkFixture(...input)
  return spawn([...argv], { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

export const importForkCredentials = (
  fork: string, cwd: string, env: Readonly<Record<string, string>>, stdin: Uint8Array,
) => {
  const { argv, ...options } = forkFixture(fork, cwd, ["auth", "import", "--standalone"], env)
  return spawnSync([...argv], { ...options, stdin, stdout: "pipe", stderr: "pipe" })
}

const checkGitArg = (arg: string, cwd: string, pathOperand = false) => {
  if (containsCheckout(arg)) return reject(`checkout path in argv: ${arg}`)
  if (/^(?:--(?:git-dir|work-tree|exec-path|config-env|template|upload-pack|receive-pack|recurse-submodules|reference|separate-git-dir)(?:=|$)|-[Cc])/.test(arg))
    return reject(`redirecting Git option: ${arg}`)
  if (/^(?:[a-z][\w+.-]*:|[^/]+@[^/]+:)/i.test(arg)) return reject(`remote operand: ${arg}`)
  if (/^-[^-].*\//.test(arg) || /^-[FtfO].+/.test(arg)) return reject(`ambiguous joined path option: ${arg}`)
  // A ref or message can look like a path; check it conservatively, including
  // single-component operands that might name a symlink.
  const value = arg.replace(/^--[\w-]+=/, "")
  if (pathOperand || !value.startsWith("-")) scratchInput(resolve(cwd, value))
}

const gitOperands = (command: string, args: ReadonlyArray<string>, cwd: string) => {
  const divider = args.indexOf("--")
  for (const [index, arg] of args.entries()) {
    const beforeDivider = divider < 0 || index < divider
    const message = command === "commit" && beforeDivider && ["-m", "--message"].includes(args[index - 1] || "")
    if (message && containsCheckout(arg)) return reject(`checkout path in Git message: ${arg}`)
    if (!message) checkGitArg(arg, cwd, divider >= 0 && index > divider)
  }
}

const cloneArgs = (args: ReadonlyArray<string>) =>
  args.length === 5 && args[0] === "--quiet" && args[1] === "--origin" &&
  /^\w[\w-]*$/.test(args[2] ?? "") && args.slice(3).every(localTestPaths.isAbsolute)

const gitCommandAllowed = (command: string, args: ReadonlyArray<string>) => {
  switch (command) {
    case "config": return [
      "gc.auto 0", "maintenance.auto false", "user.name work", "user.email work@example.com",
      'rift.gate echo " 2 pass"', 'rift.accept sleep 1 && echo " 1 fail since $RIFT_LAND_BASE" && exit 1',
    ].includes(args.join(" ")) ||
      (args.length === 2 && args[0] === "--get" && Object.hasOwn(QUIET_GIT, args[1] ?? ""))
    case "remote": return (args.length === 2 && ["get-url", "remove"].includes(args[0] ?? "") && /^\w[\w-]*$/.test(args[1] ?? "")) ||
      (args.length === 3 && args[0] === "add" && args[1] === "origin" && localTestPaths.isAbsolute(args[2] || "")) ||
      exactArgs(args, "set-head", "origin", "--auto")
    case "clone": return cloneArgs(args)
    case "fetch": return args.length === 3 && args[0] === "--quiet" && args.slice(1).every((operand) => /^\w[\w./-]*$/.test(operand))
    case "push": return args.length === 4 && args[0] === "-q" && args[1] === "-u" && args[2] === "origin" && /^\w[\w./-]*$/.test(args[3] ?? "")
    default: return gitCommands.has(command)
  }
}

/** Bootstrap exactly the test's scratch Work registry; no project or user registry leaks in. */
export const scratchWorkInit = (bin: string, cwd: string, home: string, temp: string) => {
  const work = externalInput(bin)
  const directory = scratchInput(cwd)
  const base = scratchInput(home)
  const at = scratchInput(temp)
  return spawnSync([work, "--json", "init"], {
    cwd: directory,
    env: {
      PATH: searchPath(), WORK_BASE: directory, HOME: base, TMPDIR: at,
      XDG_CONFIG_HOME: scratchInput(resolve(base, ".config")), XDG_CACHE_HOME: scratchInput(resolve(base, ".cache")),
      XDG_DATA_HOME: scratchInput(resolve(base, ".local/share")), XDG_STATE_HOME: scratchInput(resolve(base, ".local/state")),
      [marker]: "work-init",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
}

/** Git in a generated fixture. Only the identity and locale may enter from a caller. */
const scratchGit = (cwd: string, args: ReadonlyArray<string>, values: Readonly<NodeJS.ProcessEnv>) => {
  const directory = scratchInput(cwd)
  const [command = "", ...tail] = args
  if (!gitCommandAllowed(command, tail)) return reject(`unmodeled Git command: ${command}`)
  gitOperands(command, tail, directory)
  const identity = Object.entries(values).flatMap(([name, value]) =>
    (gitIdentity.test(name) && Predicate.isString(value) && !containsCheckout(value) && [[name, value]]) || [])
  const env = {
    ...Object.fromEntries(identity),
    PATH: searchPath(),
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: scratchRoot(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "gc.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
    [marker]: "git",
  }
  return { cwd: directory, env }
}

const remoteOf = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (args[0] === "push") return ["remote", "get-url", "--push", "origin"]
  if (args[0] === "fetch" || (args[0] === "remote" && args[1] === "set-head")) return ["remote", "get-url", args[2] ?? ""]
  return []
}

/** A Git invocation with checkout-independent operands and environment. */
export const spawnScratchGitSync = (cwd: string, args: ReadonlyArray<string>, env: Readonly<NodeJS.ProcessEnv> = {}, input = "") => {
  if (input && (args[0] !== "check-attr" || !args.includes("--stdin") || !args.includes("-z")))
    return reject("stdin is supported only for NUL-separated check-attr paths")
  for (const path of input.split("\0").filter(Boolean)) checkGitArg(path, cwd, true)
  const options = scratchGit(cwd, args, env)
  const git = (argv: ReadonlyArray<string>) => localTestProcess.spawnSync("git", argv, { ...options, input, stdio: ["pipe", "pipe", "pipe"] })
  const target = remoteOf(args)
  if (target.length > 0) {
    const remote = git(target)
    if (remote.status !== 0) return reject("scratch Git needs a configured local remote")
    const source = remote.stdout.toString().trim()
    if (!localTestPaths.isAbsolute(source)) return reject("scratch Git needs an absolute local remote")
    scratchInput(source)
  }
  const ran = git(args)
  if (ran.error) return reject(ran.error.message)
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

const gitQuery = (cwd: string, argv: ReadonlyArray<string>) => {
  const directory = scratchInput(cwd)
  return localTestProcess.spawnSync("git", argv, {
    cwd: directory, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: searchPath(), HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: directory,
      GIT_PAGER: "cat", PAGER: "cat", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0", [marker]: "git",
    },
  })
}

/** Ask the installed Git for the location of its own manual. The fixture's repo is never involved. */
export const installedGitManual = (cwd: string) => {
  const got = gitQuery(cwd, ["--man-path"])
  if (got.status !== 0) return reject(`git --man-path: ${got.stderr}`)
  const dir = got.stdout.trim()
  if (!localTestPaths.isAbsolute(dir)) return reject("Git manual directory is not absolute")
  const page = resolve(dir, "man1/git.1")
  const plain = (localTestPaths.existsSync(page) && localTestPaths.readFileSync(externalInput(page), "utf8")) || ""
  const zipped = `${page}.gz`
  const text = (localTestPaths.existsSync(zipped) && new TextDecoder().decode(gunzipSync(localTestPaths.readFileSync(externalInput(zipped))))) || ""
  return plain + text
}

/** Probe one installed Git option with no operation other than `version`. */
export const scratchGitVersion = (cwd: string, flag: string, value?: string) => {
  if (!/^-{1,2}[A-Za-z][A-Za-z-]*$/.test(flag) || ["-h", "--help"].includes(flag))
    return reject(`not a Git version probe option: ${flag}`)
  if (value && ![".", "core.probe=1", "core.probe=HOME", "HEAD"].includes(value))
    return reject("not a Git version probe value")
  return gitQuery(cwd, [flag, ...(value && [value] || []), "version"]).stdout.startsWith("git version ")
}

/** A fixture repository with automatic maintenance disabled, using only guarded Git. */
const quietScratchGit = (cwd: string, env: GitEnv) => {
  for (const [key, value] of Object.entries(QUIET_GIT)) {
    const ran = spawnScratchGitSync(cwd, ["config", key, value], env)
    if (ran.exitCode !== 0) return reject(ran.stderr.toString())
  }
}

export const initScratchGit = (cwd: string, flags: ReadonlyArray<string>, env: GitEnv = {}) => {
  const ran = spawnScratchGitSync(cwd, initGitArgv(flags), env)
  if (ran.exitCode !== 0) return reject(ran.stderr.toString())
  quietScratchGit(cwd, env)
}

export const cloneScratchGit = (cwd: string, source: string, destination: string, remote: string) => {
  const ran = spawnScratchGitSync(cwd, cloneGitArgv(["--quiet", "--origin", remote], source, destination))
  if (ran.exitCode !== 0) return reject(ran.stderr.toString())
  quietScratchGit(destination, {})
}

/** A fixed Git object operand in the repository, with its own explicit checkout input. */
export const checkoutBlob = (revision: string, entry: string) => {
  if (!/^[a-f0-9]{40}$/.test(revision)) return reject("a checked object read needs a full hexadecimal object ID")
  const file = matchingInput(entry)
  const objectPath = localTestPaths.relative(checkout, file)
  const ran = localTestProcess.spawnSync("git", ["show", `${revision}:${objectPath}`], {
    cwd: checkout,
    env: { PATH: searchPath(), HOME: scratchRoot(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (ran.status !== 0) return reject(ran.stderr.toString())
  return ran.stdout.toString()
}

/** Bun runs explicit, generated test files, never discovers suites in a checkout. */
export const scratchBunJUnitSync = (cwd: string, suites: ReadonlyArray<string>, report: string) => {
  const directory = scratchInput(cwd)
  const outfile = scratchInput(report)
  if (suites.length === 0) return reject("no scratch Bun test suites")
  for (const suite of suites) {
    if (!/^\.\/[\w-]+\.test\.ts$/.test(suite)) return reject(`not a scratch Bun suite: ${suite}`)
    const body = localTestPaths.readFileSync(scratchInput(resolve(directory, suite)), "utf8")
    if (containsCheckout(body)) return reject(`checkout path in generated Bun suite: ${suite}`)
  }
  const ran = localTestProcess.spawnSync(localTestProcess.execPath, ["--no-env-file", "test", "--reporter=junit", `--reporter-outfile=${outfile}`, ...suites], {
    cwd: directory,
    env: {
      PATH: searchPath(), HOME: directory, TMPDIR: directory,
      XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory, XDG_STATE_HOME: directory,
      [marker]: "bun-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (ran.error) return reject(ran.error.message)
  return { exitCode: ran.status }
}

export const writeScratchScript = (file: string, program: string) => {
  if (containsCheckout(program)) return reject("checkout path in generated shell script")
  const script = scratchInput(file)
  localTestPaths.writeFileSync(script, program)
  return script
}

interface ProgramInputs {
  readonly cwd: string
  readonly tools: string | ReadonlyArray<string>
  readonly paths: Readonly<Record<string, string>>
  readonly values: Readonly<Record<string, string>>
  readonly pathLists?: Readonly<Record<string, string>>
  readonly systemTools?: boolean
}

const programPaths = new Set([
  "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "WORKRIFT_ROOT", "WORKRIFT_PROC", "WORKRIFT_SOURCE", "WORK", "WORK_BASE", "FAKE_WORK_BASES", "FAKE_HOLDS", "FAKE_LOG",
  "XDG_RUNTIME_DIR", "WORKBOX_WORKSPACES_DIR", "WORKBOX_BACKUP_CONFIG",
  "WORKBOX_RIFT_FSTAB", "WORKBOX_SYSFS_BTRFS",
])

const programValues = new Set([
  "WORKRIFT_PURGE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
  "USER", "WORKBOX_EXPECT_MACHINE_ID", "HB_EXPECT",
])

const machineId = (value: string) => /^[0-9a-f]{32}$/.test(value) && value !== "0".repeat(32)
const programValue = (key: string, value: string) => {
  if (key === "WORKBOX_EXPECT_MACHINE_ID") return machineId(value)
  return programValues.has(key) && /^[\w @.-]*$/.test(value)
}

const checkScript = (file: string) => {
  const at = scratchInput(file)
  if (containsCheckout(localTestPaths.readFileSync(at, "utf8"))) return reject(`checkout path in generated program: ${file}`)
  return at
}

const toolDirectories = (tools: ProgramInputs["tools"]): ReadonlyArray<string> => {
  if (Predicate.isString(tools)) return [tools]
  return tools
}

const checkTools = (tools: ProgramInputs["tools"]) =>
  toolDirectories(tools).map((dir) => {
    const at = scratchInput(dir)
    if (!localTestPaths.existsSync(at)) return at
    for (const name of localTestPaths.readdirSync(at)) {
      const tool = resolve(at, name)
      if (name === "jq" && localTestPaths.isSymbolicLink(tool)) {
        const target = localTestPaths.realpathSync(tool)
        const fixed = systemPath.map((directory) => resolve(directory, "jq"))
        if (!fixed.some((path) => localTestPaths.existsSync(path) && localTestPaths.realpathSync(path) === target))
          return reject("unexpected jq fixture tool")
      } else checkScript(tool)
    }
    return at
  })

const scratchProgram = (
  interpreter: "sh" | "perl", script: string, args: ReadonlyArray<string>, input: ProgramInputs,
) => {
  const cwd = scratchInput(input.cwd)
  const tools = checkTools(input.tools)
  for (const arg of args) {
    if (containsCheckout(arg)) return reject("checkout path in fixture argv")
    if (localTestPaths.isAbsolute(arg)) scratchInput(arg)
    else if (!/^-{0,2}[\w.-]+(?: [\w.-]+)*$/.test(arg) || arg === "..") return reject(`unmodeled fixture argument: ${arg}`)
  }
  const env = new Map<string, string>()
  const put = (key: string, value: string) => {
    if (env.has(key)) return reject(`duplicate program environment: ${key}`)
    env.set(key, value)
  }
  for (const [key, value] of Object.entries(input.paths)) {
    if (!programPaths.has(key)) return reject(`unsupported program path environment: ${key}`)
    put(key, scratchInput(value))
  }
  for (const [key, value] of Object.entries(input.values)) {
    if (!programValue(key, value)) return reject(`unsupported literal program environment: ${key}`)
    put(key, value)
  }
  for (const [key, value] of Object.entries(input.pathLists || {})) {
    if (key !== "FAKE_SUBVOLUMES") return reject(`unsupported program path-list environment: ${key}`)
    put(key, value.split(":").filter(Boolean).map(scratchInput).join(":"))
  }
  const executable = { sh: "/bin/sh", perl: "/usr/bin/perl" }[interpreter]
  const argv: [string, ...Array<string>] = [executable, checkScript(script), ...args]
  const path = [...tools, input.systemTools && "/usr/bin:/bin:/usr/sbin:/sbin" || searchPath()].join(":")
  return { argv, cwd, env: { HOME: cwd, TMPDIR: cwd, ...Object.fromEntries(env), PATH: path, [marker]: interpreter } }
}

export const spawnScratchProgram = (
  script: string, args: ReadonlyArray<string>, input: ProgramInputs, stderr: Bun.BunFile,
) => {
  const { argv, ...options } = scratchProgram("sh", script, args, input)
  return spawn(argv, { ...options, stdin: "ignore", stdout: "ignore", stderr, detached: true })
}

export const runScratchTool = (script: string, args: ReadonlyArray<string>, input: ProgramInputs) => {
  const { argv, ...options } = scratchProgram("perl", script, args, input)
  return spawnSync(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

export const spawnScratchShellFileSync = (script: string, args: ReadonlyArray<string>, input: ProgramInputs) => {
  const { argv, ...options } = scratchProgram("sh", script, args, input)
  return spawnSync(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

/** Ask the staged host-pin helper for the local platform's read-only identity. */
export const fixtureHostIdentity = (cwd: string, source: string) => {
  const script = writeScratchScript(resolve(cwd, ".fixture-host-id.sh"), `${source}\nworkbox_host_identity\n`)
  const ran = spawnScratchShellFileSync(script, [], { cwd, tools: [], paths: {}, values: {}, systemTools: true })
  const value = ran.stdout.toString().trim()
  if (!ran.success || !machineId(value)) return reject("the host pin fixture did not return a machine ID")
  return value
}

export const spawnScratchShellFile = (script: string, args: ReadonlyArray<string>, input: ProgramInputs) => {
  const { argv, ...options } = scratchProgram("sh", script, args, input)
  return spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

/** Reviewable native tools used only on scratch fixtures. */
export const scratchArchive = (cwd: string, mode: "list" | "extract", archive: string, dest: string) => {
  const directory = scratchInput(cwd)
  const at = scratchInput(archive)
  const argv: [string, ...Array<string>] = ["/usr/bin/tar", "-tzf", at]
  if (mode === "extract") argv.splice(1, Infinity, "-xzf", at, "-C", scratchInput(dest))
  return spawn(argv, { cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, [marker]: "tar" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

export const scratchHostConfig = (cwd: string, tool: string, home: string, input?: { readonly runtime: string; readonly unit: string }) => {
  const directory = scratchInput(cwd)
  const exe = externalInput(tool)
  const kind = exe.split("/").at(-1)
  const env = { HOME: scratchInput(home), TMPDIR: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", [marker]: "host-config" }
  if (kind === "herdr" && !input)
    return spawn([exe, "config", "check"], { cwd: directory, env: { ...env, XDG_CONFIG_HOME: resolve(home, ".config") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (kind === "systemd-analyze" && input)
    return spawn([exe, "--user", "verify", scratchInput(input.unit)], { cwd: directory, env: { ...env, XDG_RUNTIME_DIR: scratchInput(input.runtime) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return reject("not a checked host config tool")
}

/** Write and launch exactly this fixture script, with no ambient environment. */
export const scratchShell = (cwd: string, program: string) => {
  const directory = scratchInput(cwd)
  const script = writeScratchScript(resolve(directory, "fixture.sh"), program)
  return { script, cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, [marker]: "sh" } }
}

/** A generated script for the PTY's initial or restart command. */
export const scratchPtyCommand = (program: string, label?: string): readonly [string, ...string[]] => {
  if (containsCheckout(program)) return reject("checkout path in generated PTY script")
  if (label) return ["/bin/sh", "-c", program, scratchInput(label)]
  return ["/bin/sh", "-c", program]
}

export const scratchPtyEnv = (cwd: string) => {
  const directory = scratchInput(cwd)
  return { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, [marker]: "sh-pty" }
}

/** A shell fixture whose test manages descendants itself. */
export const spawnScratchShell = (cwd: string, program: string) => {
  const { script, ...options } = scratchShell(cwd, program)
  const child = localTestProcess.spawn("/bin/sh", [script], { ...options, stdio: "ignore" })
  const pid = Option.getOrThrowWith(Option.fromUndefinedOr(child.pid), () => new ScratchChildInput({ message: "scratch child: shell did not start" }))
  const exited = localTestProcess.once(child, "exit")
  return { pid, exited }
}

interface ScratchShellInputs {
  readonly tools: string
  readonly paths: Readonly<Record<string, string>>
}

interface ShellFixtureCommand {
  readonly paths: Readonly<Record<string, string>>
  readonly self?: string
  readonly process?: Pick<ChildProcess.CommandOptions, "stdin" | "additionalFds">
}

/** A staged self-contained shell entry whose only executable targets are scratch fixture tools. */
export const checkoutShellFixtureCommand = (
  entry: string, cwd: string, args: ReadonlyArray<string>,
  { paths, self, process }: ShellFixtureCommand,
) => {
  const directory = scratchInput(cwd)
  const source = localTestPaths.readFileSync(matchingInput(entry), "utf8")
  const script = writeScratchScript(resolve(directory, entry.split("/").at(-1) ?? "fixture.sh"), source)
  const env = { HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin", [marker]: "sh" }
  if (args.some(containsCheckout)) return reject("checkout path in shell fixture argv")
  const values = new Map<string, string>()
  const put = (name: string, file: string) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name in env || /^(?:BASH|ENV|DYLD|LD_|ZDOTDIR)/.test(name) || values.has(name))
      return reject(`redirecting shell fixture environment: ${name}`)
    values.set(name, scratchInput(file))
  }
  for (const [name, file] of Object.entries(paths)) put(name, file)
  if (self) put(self, script)
  return ChildProcess.make("/bin/sh", [script, ...args], {
    cwd: directory, env: { ...env, ...Object.fromEntries(values) }, extendEnv: false,
    forceKillAfter: "2 seconds", stdin: process?.stdin ?? "pipe", additionalFds: process?.additionalFds ?? {},
  })
}

/** Run a self-contained checkout shell entry beside the fixtures it may open. */
export const spawnCheckoutShellSync = (
  cwd: string,
  entry: string,
  args: ReadonlyArray<string>,
  { tools, paths }: ScratchShellInputs,
) => {
  const body = localTestPaths.readFileSync(matchingInput(entry), "utf8")
  const { script, ...options } = scratchShell(cwd, body)
  const dir = scratchInput(tools)
  for (const tool of localTestPaths.readdirSync(dir)) {
    const file = scratchInput(resolve(dir, tool))
    if (containsCheckout(localTestPaths.readFileSync(file, "utf8"))) return reject(`checkout path in generated shell tool: ${tool}`)
  }
  for (const arg of args) {
    if (containsCheckout(arg)) return reject("checkout path in shell argv")
    scratchInput(resolve(cwd, arg))
  }
  for (const [name, file] of Object.entries(paths)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name in options.env || /^(?:BASH|ENV|DYLD|LD_|ZDOTDIR)/.test(name))
      return reject(`redirecting shell environment: ${name}`)
    scratchInput(file)
  }
  const ran = localTestProcess.spawnSync("/bin/sh", [script, ...args], {
    ...options, env: { ...paths, ...options.env, PATH: `${dir}:${options.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  })
  if (ran.error) return reject(ran.error.message)
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

/** Exercise a generated Zsh startup file, never the user's startup or login files. */
export const spawnScratchZshSync = (
  cwd: string, home: string, program: string, values: Readonly<Record<string, string>>, noStartup = false,
) => {
  const { script, ...options } = scratchShell(cwd, program)
  const homeDir = scratchInput(home)
  const startup = scratchInput(resolve(homeDir, ".zshenv"))
  if (localTestPaths.existsSync(startup) && containsCheckout(localTestPaths.readFileSync(startup, "utf8")))
    return reject("checkout path in generated Zsh startup")
  for (const [name, value] of Object.entries(values)) {
    if (containsCheckout(value)) return reject(`checkout path in Zsh fixture environment: ${name}`)
    if (name === "WORKBOX_TURBO_DOCKERFILE") scratchInput(value)
    else if (!["TURBO_TOKEN", "TURBO_CACHE"].includes(name)) return reject(`unsupported Zsh fixture environment: ${name}`)
  }
  const ran = localTestProcess.spawnSync("zsh", [...(noStartup && ["-f"] || []), script], {
    ...options, env: { ...values, ...options.env, HOME: homeDir, [marker]: "zsh" }, stdio: ["ignore", "pipe", "pipe"],
  })
  if (ran.error) return reject(ran.error.message)
  return { stdout: ran.stdout.toString(), stderr: ran.stderr.toString() }
}

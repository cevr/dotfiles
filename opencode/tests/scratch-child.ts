import { spawn, spawnSync } from "bun"
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
  return ["OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_FREE_MODELS"].includes(name) && value === "1"
}

interface FixtureEnvironment {
  readonly scratch: Readonly<Record<string, string>>
  readonly external: Readonly<Record<string, string>>
  readonly checkout?: Readonly<Record<string, string>>
  readonly values: Readonly<Record<string, string>>
  readonly scratchArgs?: ReadonlyArray<string>
}

export const checkoutBun = (entry: string, inputs: FixtureEnvironment) => {
  if (!isEntryName(entry)) return reject(`not a checkout entry: ${entry}`)
  const bunDir = resolve(localTestProcess.execPath, "..")
  if (containsCheckout(bunDir) || containsCheckout(localTestPaths.realpathSync(bunDir))) return reject("checkout directory on the fixture PATH")
  const env = new Map<string, string>([["PATH", `${bunDir}:${searchPath()}`]])
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
export const checkoutBunCommand = (entry: string, inputs: FixtureEnvironment) => {
  const { argv: [bun, ...args], ...options } = checkoutBun(entry, inputs)
  return ChildProcess.make(bun, args, { ...options, extendEnv: false, stdin: "ignore", forceKillAfter: "3 seconds" })
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
  const base = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root }
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

/** A fixed CLI mode from the pinned external fork with scratch state and a checked preload. */
export const forkFixture = (
  fork: string, cwd: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>>,
) => {
  if (!forkArgsAllowed(args)) return reject("unsupported external fork fixture command")
  const entry = externalInput(resolve(fork, "packages/cli/src/index.ts"))
  const preload = externalInput(resolve(fork, "packages/tui/node_modules/@opentui/solid/scripts/preload.js"))
  if (env.BUN_OPTIONS !== `--conditions=browser --preload=${preload}`) return reject("unexpected Bun fixture options")
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
  const path = resolve(localTestProcess.execPath, "..")
  if (containsCheckout(path) || containsCheckout(localTestPaths.realpathSync(path))) return reject("checkout directory on the fixture PATH")
  return {
    argv: [localTestProcess.execPath, "--no-env-file", entry, ...args] as const, cwd: scratchInput(cwd),
    env: { ...env, PATH: `${path}:${searchPath()}`, TMPDIR: env.TMPDIR || scratchRoot() },
  }
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
  return spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

export const importForkCredentials = (
  fork: string, cwd: string, env: Readonly<Record<string, string>>, stdin: Uint8Array,
) => {
  const { argv, ...options } = forkFixture(fork, cwd, ["auth", "import", "--standalone"], env)
  return spawnSync(argv, { ...options, stdin, stdout: "pipe", stderr: "pipe" })
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
    case "config": return ["gc.auto 0", "maintenance.auto false"].includes(args.join(" "))
    case "remote": return (args.length === 2 && ["get-url", "remove"].includes(args[0] ?? "") && /^\w[\w-]*$/.test(args[1] ?? "")) ||
      exactArgs(args, "set-head", "origin", "--auto")
    case "clone": return cloneArgs(args)
    case "fetch": return args.length === 3 && args[0] === "--quiet" && args.slice(1).every((operand) => /^\w[\w./-]*$/.test(operand))
    case "push": return args.length === 4 && args[0] === "-q" && args[1] === "-u" && args[2] === "origin" && /^\w[\w./-]*$/.test(args[3] ?? "")
    default: return gitCommands.has(command)
  }
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
  readonly tools: string
  readonly paths: Readonly<Record<string, string>>
  readonly values: Readonly<Record<string, string>>
  readonly pathLists?: Readonly<Record<string, string>>
}

const programPaths = new Set([
  "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "WORKRIFT_ROOT", "WORKRIFT_PROC", "WORKRIFT_SOURCE", "WORK", "WORK_BASE", "FAKE_WORK_BASES", "FAKE_HOLDS", "FAKE_LOG",
])

const programValues = new Set([
  "WORKRIFT_PURGE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
])

const checkScript = (file: string) => {
  const at = scratchInput(file)
  if (containsCheckout(localTestPaths.readFileSync(at, "utf8"))) return reject(`checkout path in generated program: ${file}`)
  return at
}

const scratchProgram = (
  interpreter: "sh" | "perl", script: string, args: ReadonlyArray<string>, input: ProgramInputs,
) => {
  const cwd = scratchInput(input.cwd)
  const tools = scratchInput(input.tools)
  for (const tool of localTestPaths.readdirSync(tools)) checkScript(resolve(tools, tool))
  for (const arg of args) {
    if (containsCheckout(arg)) return reject("checkout path in fixture argv")
    if (localTestPaths.isAbsolute(arg)) scratchInput(arg)
    else if (!/^-{0,2}[\w.-]+$/.test(arg) || arg === "..") return reject(`unmodeled fixture argument: ${arg}`)
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
    if (!programValues.has(key) || !/^[\w @.-]*$/.test(value)) return reject(`unsupported literal program environment: ${key}`)
    put(key, value)
  }
  for (const [key, value] of Object.entries(input.pathLists || {})) {
    if (key !== "FAKE_SUBVOLUMES") return reject(`unsupported program path-list environment: ${key}`)
    put(key, value.split(":").filter(Boolean).map(scratchInput).join(":"))
  }
  const executable = { sh: "/bin/sh", perl: "/usr/bin/perl" }[interpreter]
  const argv: [string, ...Array<string>] = [executable, checkScript(script), ...args]
  return { argv, cwd, env: { HOME: cwd, TMPDIR: cwd, ...Object.fromEntries(env), PATH: `${tools}:${searchPath()}`, [marker]: interpreter } }
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

export const spawnScratchShellFile = (script: string, args: ReadonlyArray<string>, input: ProgramInputs) => {
  const { argv, ...options } = scratchProgram("sh", script, args, input)
  return spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
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

import { Option, Predicate } from "effect"
import { COMMAND_STARTS, SHELLS, simpleCommands, type Word } from "./shell-line.ts"

export type CommandEnvironment = Readonly<Partial<Record<string, string>>>
type Invocation = { readonly argv: ReadonlyArray<string>; readonly env: CommandEnvironment }
export type CommandLine =
  | { readonly kind: "literal"; readonly runs: ReadonlyArray<Invocation> }
  | { readonly kind: "opaque"; readonly runs: ReadonlyArray<Invocation>; readonly unresolved: boolean }

const opaque: CommandLine = { kind: "opaque", runs: [], unresolved: true }
const literal = (runs: ReadonlyArray<Invocation>): CommandLine => ({ kind: "literal", runs })
const advisory = (line: CommandLine): CommandLine => {
  if (line.kind === "opaque") return line
  return { kind: "opaque", runs: line.runs, unresolved: false }
}
export const executable = (head: string) => head.split("/").at(-1) ?? ""
const assignment = /^([A-Za-z_]\w*)=(.*)$/su
const assign = (env: CommandEnvironment, [key, value]: readonly [string, string]) => ({ ...env, [key]: value })
const binding = (arg: string) => {
  const [, key, value] = assignment.exec(arg) ?? []
  return Option.zipWith(Option.fromNullishOr(key), Option.fromNullishOr(value), (name, text) => [name, text] as const)
}
const envName = /^[A-Za-z_]\w*$/u
const unset = (env: CommandEnvironment, key: string) => {
  const next = { ...env }
  delete next[key]
  return next
}
const literalSplit = (source: string): ReadonlyArray<string> => source.trim().split(/[ \t]+/u).filter(Boolean)

// macOS env(1) and GNU Coreutils env(1), “Options” / “-S”. Do not
// give shell quoting or expansion semantics to env's different -S grammar.
type EnvOption = { readonly kind: "clear" | "unset" | "split" | "chdir"; readonly value: string; readonly words: number }
const envFlag = (arg: string, gnu: boolean) => {
  const short = Option.fromNullishOr(/^(-[uCS])(.+)?$/su.exec(arg))
  if (!gnu) return short
  return Option.orElse(short, () => Option.fromNullishOr(/^(--unset|--chdir|--split-string)(?:=(.*))?$/su.exec(arg)))
}
const envOption = (arg: string, next: string, gnu: boolean): Option.Option<EnvOption> => {
  if (arg === "-i" || (gnu && arg === "--ignore-environment")) return Option.some({ kind: "clear", value: "", words: 1 })
  const flag = envFlag(arg, gnu)
  if (Option.isNone(flag)) return Option.none()
  const [, name, attached] = flag.value
  const value = attached ?? next
  const words = 1 + Number(Predicate.isUndefined(attached))
  if (!value) return Option.none()
  if (name === "-u" || name === "--unset") return Option.liftPredicate({ kind: "unset" as const, value, words }, () => envName.test(value))
  if (name === "-S" || name === "--split-string") {
    return Option.liftPredicate({ kind: "split" as const, value, words }, () => /^[ \tA-Za-z0-9_./=:+,%@-]+$/u.test(value))
  }
  // chdir does not change env. It can change the tool's config lookup;
  // the width model never relies on that lookup.
  return Option.some({ kind: "chdir" as const, value, words })
}
const envAssignments = (input: ReadonlyArray<string>, initial: CommandEnvironment) => {
  let argv = input
  let env = initial
  for (;;) {
    const next = binding(argv[0] ?? "")
    if (Option.isNone(next)) break
    env = assign(env, next.value)
    argv = argv.slice(1)
  }
  // After the first assignment an option-looking word is not an option.
  if (argv[0]?.startsWith("-")) return Option.none()
  return Option.some({ argv, env })
}
const envPrefix = (input: ReadonlyArray<string>, initial: CommandEnvironment) => {
  let argv = input
  let env = initial
  let splits = 0
  while (argv[0]?.startsWith("-")) {
    const [arg = "", next = ""] = argv
    if (arg === "--" || arg === "-") {
      argv = argv.slice(1)
      if (arg === "-") env = {}
      break
    }
    const option = envOption(arg, next, process.platform === "linux")
    if (Option.isNone(option)) return Option.none()
    const { kind, value, words } = option.value
    argv = argv.slice(words)
    if (kind === "clear") env = {}
    if (kind === "unset") env = unset(env, value)
    if (kind === "split") {
      if (++splits > 4) return Option.none()
      argv = [...literalSplit(value), ...argv]
    }
  }
  return envAssignments(argv, env)
}

const words = (text: string) => new Set(text.split(" ").filter(Boolean))
const wrapper = (switches = "", values = "", positionals = 0) => ({ switches: words(switches), values: words(values), positionals })
const wrappers: ReadonlyMap<string, ReturnType<typeof wrapper>> = new Map([
  ["nice", wrapper("", "-n --adjustment")],
  ["timeout", wrapper("--foreground --preserve-status --verbose -v", "-k --kill-after -s --signal", 1)],
  ["flock", wrapper("-s --shared -x --exclusive -n --nonblock -o --close -F --no-fork -v --verbose", "-w --wait --timeout -E --conflict-exit-code", 1)],
  ["setsid", wrapper("-c --ctty -f --fork -w --wait")],
  ["nohup", wrapper()],
  ["time", wrapper("-p")],
  ["ionice", wrapper("-t --ignore", "-c --class -n --classdata")],
  ["stdbuf", wrapper("", "-i --input -o --output -e --error")],
  ["sudo", wrapper("-n -E -H -S", "-u --user -g --group -C --close-from")],
  ["doas", wrapper("-n", "-u")],
  ["npx", wrapper("-y --yes --no", "-p --package")],
  ["bunx", wrapper("--bun --verbose --silent", "-p --package")],
  ["pnpx", wrapper()],
])
const wrapperOption = (tool: string, spec: ReturnType<typeof wrapper>, arg: string) => {
  if (spec.switches.has(arg) || (tool === "nice" && /^-[0-9]+$/u.test(arg))) return 1
  if (spec.values.has(arg)) return 2
  const name = arg.split("=")[0] ?? ""
  if (name.startsWith("--") && name !== arg && spec.values.has(name)) return 1
  if (/^-[A-Za-z]./u.test(arg) && spec.values.has(arg.slice(0, 2))) return 1
  return 0
}
const wrapperTail = (tool: string, spec: ReturnType<typeof wrapper>, args: ReadonlyArray<string>) => {
  let at = 0
  while (args[at]?.startsWith("-")) {
    const arg = args[at] ?? ""
    if (arg === "--") return Option.some(args.slice(at + 1 + spec.positionals))
    if (tool === "flock" && (arg === "-c" || arg === "--command")) return Option.some(args.slice(at))
    const take = wrapperOption(tool, spec, arg)
    if (take === 0 || at + take > args.length) return Option.none()
    at += take
  }
  return Option.some(args.slice(at + spec.positionals))
}
const opaqueEnvironment = words("sudo doas npx bunx pnpx stdbuf")
const delimit = (args: ReadonlyArray<string>) => {
  if (args[0] === "--") return args.slice(1)
  return args
}
const shellBuiltins = words("! { command exec")
const shellChild = (argv: ReadonlyArray<string>, args: ReadonlyArray<string>, env: CommandEnvironment, depth: number) => {
  const [flag, source] = args
  if (flag !== "-c" || Predicate.isUndefined(source)) {
    if (args[0]?.startsWith("-")) return opaque
    return literal([{ argv, env }]) // a script file is not inspected
  }
  const run = parseShell(source, env, depth + 1)
  if (executable(argv[0] ?? "") === "zsh" || env.BASH_ENV || env.ENV || Object.keys(env).some((key) => key.startsWith("BASH_FUNC_"))) return advisory(run)
  return run
}
const envChild = (argv: ReadonlyArray<string>, args: ReadonlyArray<string>, env: CommandEnvironment, depth: number) =>
  Option.match(envPrefix(args, env), {
    onNone: () => opaque,
    onSome: (next) => {
      if (!next.argv.length) return literal([{ argv, env }])
      return child(next.argv, next.env, depth + 1)
    },
  })
const wrapperChild = (named: string, argv: ReadonlyArray<string>, args: ReadonlyArray<string>, env: CommandEnvironment, depth: number, shell: boolean) => {
  const spec = wrappers.get(named)
  if (!spec) return literal([{ argv, env }])
  const tail = wrapperTail(named, spec, args)
  if (Option.isNone(tail)) return opaque
  const [flag, source, ...extra] = tail.value
  if (named === "flock" && (flag === "-c" || flag === "--command")) {
    if (Predicate.isUndefined(source) || extra.length) return opaque
    return advisory(parseShell(source, env, depth + 1))
  }
  const run = child(tail.value, env, depth + 1, shell && named === "time")
  if (opaqueEnvironment.has(named)) return advisory(run)
  return run
}
/** A shell's own words before a command: `L=value` (alone it runs
 * nothing, a resolved no-op; a substitution in the value is a run of its own
 * in `simpleCommands`), and `while`, `until`, `if`, `do`, `then`,
 * `elif`, `else`, which run the command after them. */
const shellWords = (shell: boolean, head: string, args: ReadonlyArray<string>, env: CommandEnvironment, depth: number): Option.Option<CommandLine> => {
  if (!shell) return Option.none()
  const bound = binding(head)
  if (Option.isSome(bound) && args.length === 0) return Option.some(literal([]))
  if (Option.isSome(bound)) return Option.some(child(args, assign(env, bound.value), depth + 1, true))
  if (COMMAND_STARTS.has(head) && args.length > 0) return Option.some(child(args, env, depth + 1, true))
  return Option.none()
}

function child(argv: ReadonlyArray<string>, env: CommandEnvironment, depth: number, shell = false): CommandLine {
  const [head = "", ...args] = argv
  if (!head || depth >= 20) return opaque
  const named = executable(head)
  const own = shellWords(shell, head, args, env, depth)
  if (Option.isSome(own)) return own.value
  if (named === "env") return envChild(argv, args, env, depth)
  if (SHELLS.has(named)) return shellChild(argv, args, env, depth)
  if ((named === "pnpm" || named === "yarn") && (args[0] === "exec" || args[0] === "dlx"))
    return advisory(child(delimit(args.slice(1)), env, depth + 1))
  if (shell && shellBuiltins.has(head)) {
    const tail = delimit(args)
    if (tail[0]?.startsWith("-")) return opaque
    return child(tail, env, depth + 1, true)
  }
  if (shell && head === "eval") return advisory(parseShell(args.join(" "), env, depth + 1))
  return wrapperChild(named, argv, args, env, depth, shell)
}

const dynamicWord = ({ text, bareStart }: Word) =>
  text.includes("$") || text.includes("`") || (bareStart && /[~*?[\]{}<>#]/u.test(text))

export function parseShell(source: string, env: CommandEnvironment = {}, depth = 0): CommandLine {
  if (depth >= 20) return opaque
  const commands = simpleCommands(source)
  const parsed = commands.map((run) => child(run.map(({ text }) => text), env, depth + 1, true))
  const [first] = parsed
  if (first && parsed.length === 1 && !/[\\`<>]/u.test(source) && !commands.some((run) => run.some(dynamicWord))) return first
  return { kind: "opaque", runs: parsed.flatMap((run) => run.runs), unresolved: parsed.some((run) => run.kind === "opaque" && run.unresolved) }
}

export const parseArgv = (argv: ReadonlyArray<string>, env: CommandEnvironment = {}): CommandLine => child(argv, env, 0)

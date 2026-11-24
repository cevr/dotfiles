// The keychain reader's execution plan. Wrapper options locate the next
// executable; runtime options say which code runs before its entry point.
import { Array as Arr, Option, Schema } from "effect"
import { compoundList, type ShellChain, type ShellList, type ShellNode } from "./compound.ts"
import { basename, dirname, resolve } from "./path.ts"
import { gitAction } from "./revision.ts"
import { backquoteEnd, COMMAND_STARTS, expandWord, SHELLS, shellInput, simpleCommands, substitutionEnd, type Word } from "./shell-line.ts"
import { gitSubcommand } from "./verdict.ts"

type OptionKind = "flag" | "value" | "directory" | "manifest" | "preload" | "code" | "module" | "stop" | "replace" | "check"
type Options = ReadonlyMap<string, OptionKind>
const options = (...groups: ReadonlyArray<readonly [OptionKind, string]>): Options =>
  new Map(groups.flatMap(([kind, words]) => words.split(" ").map((name) => [name, kind] as const)))
const envOptions = options(["value", "-u --unset -C --chdir -S --split-string"], ["flag", "-i --ignore-environment -0 --null"], ["stop", "-h --help --version"])
const packageDirectory = ["directory", "--prefix -C --dir --cwd"] as const
const bunCommands = new Set(["run", "test", "build", "x", "exec", "install", "add", "remove", "update"])
const launcherOptions = new Map([
  ["npm", options(packageDirectory, ["value", "--workspace -w --userconfig --registry"])],
  ["pnpm", options(packageDirectory, ["value", "--filter -F --workspace-root"])],
  ["yarn", options(packageDirectory, ["value", "--use-yarnrc --modules-folder"])],
  ["make", options(["directory", "-C --directory"], ["value", "-f --file --makefile -I --include-dir"])],
  ["cargo", options(["manifest", "--manifest-path"], ["directory", "-C"], ["value", "--config --target --package -p --features"])],
])

const runtimeOptions = new Map([
  ["node", options(
    ["preload", "-r --require --import --loader --experimental-loader"],
    ["code", "-e --eval -p --print"],
    ["value", "--env-file --env-file-if-exists --conditions -C --title --icu-data-dir --redirect-warnings --disable-warning"],
    ["flag", "--no-warnings --experimental-vm-modules --enable-source-maps --experimental-strip-types"],
    ["check", "-c --check"], ["stop", "-h --help -v --version"],
  )],
  ["bun", options(
    ["preload", "--preload -r"], ["code", "-e --eval -p --print"],
    packageDirectory, ["value", "--config --env-file --conditions --filter --loader --define --port"],
    ["flag", "--smol --watch --hot --silent --no-install --bun"], ["stop", "-h --help -v --version --revision"],
  )],
  ["deno", options(
    ["preload", "--preload"], ["value", "-c --config --import-map --env-file --location --lock"],
    ["flag", "-A --allow-all --allow-read --allow-run --allow-net --no-check --quiet"], ["stop", "-h --help -V --version"],
  )],
  ["tsx", options(
    ["preload", "-r --require --import --loader"], ["code", "-e --eval -p --print"],
    ["value", "--tsconfig"], ["flag", "--no-cache"], ["stop", "-h --help -v --version"],
  )],
  ["ts-node", options(
    ["preload", "-r --require"], ["code", "-e --eval -p --print"],
    ["value", "-P --project -O --compilerOptions -C --compiler"], ["flag", "-T --transpileOnly --esm"], ["stop", "-h --help -v --version"],
  )],
  ["python", options(
    ["code", "-c"], ["module", "-m"], ["value", "-W -X"],
    ["flag", "-B -d -E -I -O -OO -q -s -S -u -v -x"], ["stop", "-h --help -V --version"],
  )],
])

const wrapperOptions = new Map([
  ["env", envOptions],
  ["nice", options(["value", "-n --adjustment"], ["stop", "--help --version"])],
  ["time", options(["value", "-f --format -o --output"], ["flag", "-p -v --verbose -a --append"], ["stop", "--help --version"])],
  ["exec", options(["value", "-a"], ["flag", "-c -l"])],
  ["timeout", options(["value", "-s -k --signal --kill-after"], ["flag", "--foreground --preserve-status -v --verbose"], ["stop", "--help --version"])],
  ["command", options(["flag", "-p"], ["stop", "-v -V -pv -pV"])],
  ["sudo", options(["value", "-u -g -h -p -C --user --group --host --prompt --chdir"], ["flag", "-n -E -H --non-interactive --preserve-env"], ["stop", "-V --version -h --help"])],
  ["doas", options(["value", "-u -C"], ["flag", "-n"])],
  ["builtin", options(["stop", "--help"])],
  ["nohup", options(["stop", "--help --version"])],
  ["!", options()],
  ["{", options()],
  ["xargs", options(
    ["replace", "-I --replace"],
    ["value", "-L -P -s -n -d -E -a --max-lines --max-procs --max-chars --max-args --delimiter --eof --arg-file"],
    ["flag", "-0 -r -t -p -x -o --null --no-run-if-empty --verbose --interactive --exit --open-tty"], ["stop", "--help --version"],
  )],
])

const scriptNamePattern = /\.(?:[cm]?[jt]s|tsx|(?:ba|da|k|z)?sh|py)$/
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/
export const word = (text: string): Word => ({ text, bareStart: true, singleQuoted: false })
const runtime = (head: string): string => head.replace(/^python(?:[23](?:\.\d+)?)?$/, "python")

export const READERS: ReadonlySet<string> = new Set([
  "echo", "printf", "grep", "rg", "ag", "pgrep", "pkill", "killall", "ps", "cat", "which", "type", "command", "man", "ls", "git", "lsof",
  "head", "tail", "less", "more", "shellcheck", "shfmt", "vi", "vim", "nvim", "nano", "emacs", "code",
  "true", "false", "pwd", "test", "[", ":", "trap",
])

const isDirectory = (head: string): boolean => head === "cd" || head === "pushd" || head === "popd"
const selectorSubcommands = new Set(["checkout", "switch", "restore", "reset", "bisect", "rebase", "worktree"])
const isSelector = (args: ReadonlyArray<Word>): boolean => {
  const operation = gitSubcommand(args.map(({ text }) => text))
  return operation.kind === "command" && (selectorSubcommands.has(operation.name) || !literalPath(operation.name))
}

interface Flag {
  readonly name: string
  readonly attached: Option.Option<Word>
}
const flag = (input: Word, table: Options): Flag => {
  const equals = input.text.indexOf("=")
  if (input.text.startsWith("--") && equals > 0) return { name: input.text.slice(0, equals), attached: Option.some({ ...input, text: input.text.slice(equals + 1) }) }
  const key = input.text.slice(0, 2)
  if (/^-[^-].+/.test(input.text) && !table.has(input.text) && ["code", "value", "directory", "manifest", "module", "preload", "replace"].includes(table.get(key) || "")) {
    return { name: key, attached: Option.some({ ...input, text: input.text.slice(2) }) }
  }
  return { name: input.text, attached: Option.none() }
}

interface Invocation {
  readonly words: ReadonlyArray<Word>
  readonly env: ReadonlyMap<string, string>
  readonly directory: Option.Option<string>
}
const empty = (env: ReadonlyMap<string, string>): Invocation => ({ words: [], env, directory: Option.none() })

/** Literal xargs input: no shell substitutions, format interpretation or glob guesses. */
const literalInput = (words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const [head, ...args] = words
  if (head?.text === "echo" && args.every((entry) => entry.singleQuoted || !/[$`*?\\]/.test(entry.text))) return args
  const [format, ...data] = args
  if (head?.text !== "printf" || !/^%s(?:\\n)?$/.test(format?.text || "")) return []
  return data.filter((entry) => entry.singleQuoted || !/[$`*?\\]/.test(entry.text))
}

interface WrapperTail {
  readonly words: ReadonlyArray<Word>
  readonly replacement: Option.Option<string>
}

const wrapperTail = (args: ReadonlyArray<Word>, table: Options, replacement = Option.none<string>()): WrapperTail => {
  for (const [index, entry] of args.entries()) {
    if (entry.text === "--") return { words: args.slice(index + 1), replacement }
    if (!entry.text.startsWith("-") || entry.text === "-") return { words: args.slice(index), replacement }
    const item = flag(entry, table)
    const kind = table.get(item.name)
    if (kind === "stop" || (/^-[pvV]+$/.test(entry.text) && /[vV]/.test(entry.text) && table.has("-V"))) return { words: [], replacement }
    if (kind === "value" && Option.isNone(item.attached)) return wrapperTail(args.slice(index + 2), table, replacement)
    if (kind === "replace") return replacementTail(item, args.slice(index + 1), table)
  }
  return { words: [], replacement }
}

const replacementTail = (item: Flag, tail: ReadonlyArray<Word>, table: Options): WrapperTail => {
  if (Option.isSome(item.attached)) return wrapperTail(tail, table, Option.some(item.attached.value.text))
  if (item.name === "--replace") return wrapperTail(tail, table, Option.some("{}"))
  return wrapperTail(tail.slice(1), table, Option.map(Arr.head(tail), (entry) => entry.text))
}

const assigned = (input: Word, env: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const split = input.text.indexOf("=")
  return new Map([...env, [input.text.slice(0, split), input.text.slice(split + 1)]])
}

/** Peel wrappers once, in argv order. Xargs' known command is inspected with any literal input appended. */
const executable = (
  words: ReadonlyArray<Word>,
  input: ReadonlyArray<Word>,
  env: ReadonlyMap<string, string>,
  directory = Option.none<string>(),
): Invocation => {
  const [entry, ...args] = words
  if (!entry) return empty(env)
  if (assignment.test(entry.text)) return executable(args, input, assigned(entry, env), directory)
  const head = basename(entry.text)
  if (entry.bareStart && COMMAND_STARTS.has(entry.text)) return executable(args, input, env, directory)
  const table = Option.fromUndefinedOr(wrapperOptions.get(head))
  if (head === "env") return environment(args, input, env, directory)
  if (head === "nice" && /^-\d+$/.test(args[0]?.text || "")) return executable(args.slice(1), input, env, directory)
  if (Option.isSome(table)) return unwrap(head, args, input, env, directory, table.value)
  return { words, env, directory }
}

const unwrap = (head: string, args: ReadonlyArray<Word>, input: ReadonlyArray<Word>, env: ReadonlyMap<string, string>, directory: Option.Option<string>, table: Options): Invocation => {
  const next = wrapperTail(args, table)
  if (head === "xargs") return executable(xargsWords(next, input), [], env, directory)
  if (head === "timeout") return executable(next.words.slice(1), input, env, directory)
  if (head === "exec" && args[0]?.text === "-c") return executable(next.words, input, new Map(), directory)
  return executable(next.words, input, env, directory)
}

const xargsWords = (next: WrapperTail, input: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (next.words.length === 0) return []
  const values = input.map((item) => ({ ...item, text: item.text.replaceAll(unknownTarget, historyTarget) }))
  if (Option.isNone(next.replacement)) return [...next.words, ...xargsArguments(values)]
  const pattern = next.replacement.value
  if (pattern === "") return next.words
  const value = values.map((entry) => entry.text).join(" ") || historyTarget
  return next.words.map((entry) => ({ ...entry, text: entry.text.replaceAll(pattern, value) }))
}

const xargsArguments = (input: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (input.length > 0) return input
  return [word(historyTarget)]
}

const environment = (args: ReadonlyArray<Word>, input: ReadonlyArray<Word>, env: ReadonlyMap<string, string>, cwd: Option.Option<string>): Invocation => {
  const [entry, ...rest] = args
  if (!entry) return empty(env)
  const item = flag(entry, envOptions)
  const kind = envOptions.get(item.name)
  if (kind === "stop") return empty(env)
  if (item.name === "-i" || item.name === "--ignore-environment") return environment(rest, input, new Map(), cwd)
  if (kind === "flag") return environment(rest, input, env, cwd)
  if (kind !== "value") return executable(restIfTerminator(entry, args), input, env, cwd)
  const value = Option.orElse(item.attached, () => Arr.head(rest))
  if (Option.isNone(value)) return empty(env)
  const next = rest.slice(Number(Option.isNone(item.attached)))
  if (item.name === "-C" || item.name === "--chdir") return environment(next, input, env, Option.some(value.value.text))
  if (item.name === "-S" || item.name === "--split-string") return executable([...simpleCommands(value.value.text).flat(), ...next], input, env, cwd)
  const kept = new Map(env)
  kept.delete(value.value.text)
  return environment(next, input, kept, cwd)
}

const restIfTerminator = (entry: Word, args: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (entry.text === "--") return args.slice(1)
  return args
}

export type Language = "shell" | "js" | "python" | "auto"
type LoadPhase = "entry" | "require" | "loader" | "import"
export type CodeInput =
  | { readonly kind: "file"; readonly source: Word; readonly language: Language; readonly phase: LoadPhase }
  | { readonly kind: "inline"; readonly code: string; readonly language: Language }

const file = (source: Word, language: Language, phase: LoadPhase = "entry"): CodeInput => ({ kind: "file", source, language, phase })
const inline = (code: string, language: Language): CodeInput => ({ kind: "inline", code, language })
const languageOf = (path: string): Language => {
  if (path.endsWith(".py")) return "python"
  if (/\.(?:ba|da|k|z)?sh$/.test(path)) return "shell"
  if (scriptNamePattern.test(path)) return "js"
  return "auto"
}

const moduleFile = (value: Word): Word => ({ ...value, text: `${value.text.replaceAll(".", "/")}.py` })

interface RuntimeRead {
  readonly code: ReadonlyArray<CodeInput>
  readonly runs: boolean
}
const stopped: RuntimeRead = { code: [], runs: false }
const noEntry: RuntimeRead = { code: [], runs: true }
const append = (entry: Option.Option<CodeInput>, following: RuntimeRead): RuntimeRead => ({ ...following, code: [...Option.toArray(entry), ...following.code] })

const preloadPhase = (option: string): LoadPhase => {
  if (option === "--import") return "import"
  if (option.endsWith("loader")) return "loader"
  return "require"
}

const fromOption = (kind: OptionKind, option: string, value: Word, language: Language): Option.Option<CodeInput> => {
  if (kind === "code") return Option.some(inline(value.text, language))
  if (kind === "module") return Option.some(file(moduleFile(value), language))
  if (kind === "preload") return Option.some(file({ ...value, text: value.text.replace(/^file:\/\/(?:localhost)?(?=\/)/, "") }, language, preloadPhase(option)))
  return Option.none()
}

interface Runtime {
  readonly name: string
  readonly language: Language
  readonly options: Options
}
const entryFor = (source: Word, spec: Runtime): Option.Option<CodeInput> =>
  Option.map(Option.liftPredicate(source, ({ text }) => text !== "-" && isEntryPoint(text, spec)), (entry) => file(entry, spec.language))

const isEntryPoint = (text: string, spec: Runtime): boolean =>
  spec.language === "python" || spec.name === "node" || spec.name === "tsx" || spec.name === "ts-node" || scriptNamePattern.test(text) || text.includes("/")

const runtimeValue = (kind: OptionKind, item: Flag, after: ReadonlyArray<Word>, spec: Runtime, canRun: boolean): RuntimeRead => {
  const value = Option.orElse(item.attached, () => Arr.head(after))
  const code = Option.flatMap(value, (operand) => fromOption(kind, item.name, operand, spec.language))
  if (kind === "code" || kind === "module") return append(code, noEntry)
  const next = after.slice(Number(Option.isNone(item.attached)))
  const following = readRuntime(next, spec, canRun)
  if (!following.runs) return following
  return append(code, following)
}

const readRuntime = (args: ReadonlyArray<Word>, spec: Runtime, canRun = true): RuntimeRead => {
  const [entry, ...after] = args
  if (!entry) return noEntry
  const item = flag(entry, spec.options)
  const kind = spec.options.get(item.name)
  if (kind === "stop") return stopped
  if (entry.text === "--") return append(Option.flatMap(Arr.head(after), (source) => entryFor(source, spec)), noEntry)
  if (kind === "flag") return readRuntime(after, spec, canRun)
  if (kind === "check") return startupOnly(readRuntime(after, spec, canRun))
  if (kind) return runtimeValue(kind, item, after, spec, canRun)
  if (entry.text.startsWith("-") && entry.text !== "-") return unknownOption(item, after, spec, canRun)
  if (spec.name === "deno" && canRun && entry.text === "check") return stopped
  if ((spec.name === "bun" || spec.name === "deno") && canRun && entry.text === "run") return readRuntime(after, spec, false)
  return append(entryFor(entry, spec), noEntry)
}

/** Node's syntax-only entry still runs Node's startup modules. */
const startupOnly = (read: RuntimeRead): RuntimeRead => ({ ...read, code: read.code.filter((entry) => entry.kind === "file" && entry.phase !== "entry") })

/** An unrecognized option may run its next operand as source. Look for evidence there, without discarding the real entry point. */
const unknownOption = (item: Flag, after: ReadonlyArray<Word>, spec: Runtime, canRun: boolean): RuntimeRead => {
  const possible = Option.orElse(item.attached, () => Arr.head(after))
  if (Option.isNone(possible) || possible.value.text.startsWith("-")) return readRuntime(after, spec, canRun)
  const source = possible.value
  const following = readRuntime(after.slice(Number(Option.isNone(item.attached))), spec, canRun)
  // An unknown option could also be an eval-like option, not only a file option.
  return { ...following, code: [inline(source.text, spec.language), file(source, spec.language, "require"), ...following.code] }
}

const nodeEnv = (env: ReadonlyMap<string, string>, spec: Runtime): ReadonlyArray<CodeInput> =>
  Option.getOrElse(Option.map(Option.fromUndefinedOr(env.get("NODE_OPTIONS")), (value) => readRuntime(simpleCommands(value).flat(), spec).code), () => [])

/** Node loads CommonJS require hooks before ESM loaders, prespawns import modules before the entry point. */
const nodeOrder = (units: ReadonlyArray<CodeInput>): ReadonlyArray<CodeInput> => {
  const phases: ReadonlyArray<LoadPhase> = ["require", "loader", "import"]
  return [
    ...phases.flatMap((phase) => units.filter((unit) => unit.kind === "file" && unit.phase === phase)),
    ...units.filter((unit) => unit.kind === "inline" || unit.phase === "entry"),
  ]
}

/** Ordered code units for one resolved executable. Git and browser argv are read from the same invocation. */
const codeInputs = (head: string, path: string, args: ReadonlyArray<Word>, env: ReadonlyMap<string, string>): ReadonlyArray<CodeInput> => {
  if (SHELLS.has(head)) return shellCode(args)
  if (head === "eval") return [inline(args.map((entry) => entry.text).join(" "), "shell")]
  if (head === "source" || head === ".") return Option.toArray(Option.map(Arr.head(args), (entry) => file(entry, "shell")))
  const name = runtime(head)
  const known = Option.fromUndefinedOr(runtimeOptions.get(name))
  if (Option.isSome(known)) {
    const spec: Runtime = { name, language: "js", options: known.value }
    if (name === "python") return readRuntime(args, { ...spec, language: "python" }).code
    const result = readRuntime(args, spec)
    if (name === "node" && result.runs) return nodeOrder([...nodeEnv(env, spec), ...result.code])
    return result.code
  }
  if (path.includes("/")) return [file(word(path), languageOf(path))]
  return []
}

const shellCode = (args: ReadonlyArray<Word>): ReadonlyArray<CodeInput> => {
  const input = shellInput(args)
  if (input.noexec) return []
  const operand = Arr.head(input.operands)
  if (input.command) return Option.toArray(Option.map(operand, (entry) => inline(entry.text, "shell")))
  if (input.stdin) return []
  return Option.toArray(Option.map(Option.filter(operand, (entry) => entry.text !== "-"), (entry) => file(entry, "shell")))
}

export interface ExecutionPlace {
  readonly cwd: string
  readonly home: string
  readonly env?: ReadonlyMap<string, string>
  readonly unknownCwd?: true
  readonly positionals?: ReadonlyArray<string>
}

export interface Execution {
  readonly head: string
  readonly args: ReadonlyArray<Word>
  readonly command: string
  readonly cwd: string
  readonly unknownCwd?: true
  readonly env: ReadonlyMap<string, string>
  readonly code: ReadonlyArray<CodeInput>
  readonly sourceDepth: number
  readonly syntaxOnly: boolean
  readonly positionals: ReadonlyArray<string>
}

export const MAX_CODE_DEPTH = 6
export const unknownTarget = "\0guard:unresolved"
export const historyTarget = "\0guard:history"
const iterationTarget = /\0guard:loop:(\d+)\0/g
const loopMarker = (id: number): string => `\0guard:loop:${id}\0`
const variable = /\$(?:\{([A-Za-z_]\w*|\d+|[@*])(?:(:?)-([^}]*))?\}|([A-Za-z_]\w*|\d+|[@*?!#-]))/g
const shellExpansion = "\\$\\(|`|" + variable.source + "|\\$\\{"
type Alternatives = ReadonlyArray<string>
type Bindings = ReadonlyMap<string, Alternatives>

const expanded = (entry: Word, place: ExecutionPlace, vars: ReadonlyMap<string, string>): string => {
  const text = expandWord(entry, place.home, expansionCwd(place))
  if (entry.singleQuoted) return text
  return text.replace(variable, (use, braces: string, colon: string, fallback: string, bare: string) => vars.get(braces || bare) || fallback || use)
}

/** Expand the finite readings of a word; never execute substitutions or infer an environment value. */
const alternatives = (entry: Word, state: ShellState): Alternatives => {
  const { place, bindings } = state
  const text = expandWord(entry, place.home, expansionCwd(place))
  if (entry.singleQuoted) return [text]
  let values: Alternatives = [""]
  let at = 0
  const expansions = new RegExp(shellExpansion, "g")
  for (let match = expansions.exec(text); match; match = expansions.exec(text)) {
    const [use, braces, colon, fallback, bare] = match
    const prefix = text.slice(at, match.index)
    const dynamic = substitutionReading(text, match.index, use, state)
    const choices = Option.getOrElse(Option.map(dynamic, ({ value }) => [value]), () => {
      const name = braces || bare || ""
      const otherwise = Option.fromUndefinedOr(fallback)
      const defaultReading = () => Option.getOrElse(Option.map(otherwise, (value) => alternatives(word(value), state)), () => [unknownTarget])
      return variableChoices(name, bindings.get(name), colon || "", defaultReading)
    })
    values = values.flatMap((value) => choices.map((choice) => value + prefix + choice))
    at = Option.getOrElse(Option.map(dynamic, ({ end }) => end), () => expansions.lastIndex)
    expansions.lastIndex = at
  }
  return values.map((value) => value + text.slice(at))
}

const substitutionReading = (text: string, at: number, opening: string, state: ShellState): Option.Option<{ readonly end: number; readonly value: string }> => {
  if (opening === "$(") return Option.some(substitutionValue(text, at + 2, substitutionEnd(text, at + 2), state))
  if (opening === "`") return Option.some(substitutionValue(text, at + 1, backquoteEnd(text, at + 1), state))
  return Option.none()
}

const substitutionValue = (text: string, start: number, end: number, state: ShellState) => {
  const isolated = { ...state, projection: { ...state.projection, witnesses: new Map() } }
  const flow = walkList(compoundList(text.slice(start, end - 1)), startFlow(isolated, true), emptyStream, MAX_CODE_DEPTH)
  return { end, value: producerValue(flow.limited || flow.paths.some(({ output }) => output.history)) }
}

const producerValue = (history: boolean): string => {
  if (history) return historyTarget
  return unknownTarget
}

const historyProducers = new Set(["rev-list", "log", "reflog", "bisect", "merge-base", "describe"])
const producesHistory = (words: ReadonlyArray<Word>): boolean => {
  const [entry, ...args] = executable(words, [], new Map()).words
  if (!entry || basename(entry.text) !== "git") return false
  const subcommand = gitSubcommand(args.map(({ text }) => text))
  if (subcommand.kind !== "command") return false
  const { name, rest } = subcommand
  if (historyProducers.has(name)) return true
  if (name === "rev-parse") return rest.some((value) => !value.startsWith("-") && /[~^]|@\{|^:\/|\.\./.test(value))
  if (name === "tag") return rest.length === 0 || rest.some((value) => value === "-l" || /^--list(?:=|$)/.test(value))
  return false
}

const variableChoices = (name: string, bound: Alternatives | void, colon: string, fallback: () => Alternatives): Alternatives => {
  if (!bound && /^\d+$/.test(name)) return fallback()
  if (!bound) return [unknownTarget]
  return bound.flatMap((value) => {
    if (colon === ":" && value === "") return fallback()
    return [value]
  })
}

const bind = (entry: Word, state: ShellState): Bindings => {
  const split = entry.text.indexOf("=")
  const values = alternatives({ ...entry, bareStart: true, text: entry.text.slice(split + 1) }, state)
  return new Map([...state.bindings, [entry.text.slice(0, split), values]])
}

const initialBindings = (positionals: ReadonlyArray<string>): Bindings =>
  new Map([["@", positionalList(positionals)], ...positionals.map((value, index): [string, Alternatives] => [String(index + 1), [value]])])

const positionalList = (positionals: ReadonlyArray<string>): Alternatives => {
  if (positionals.length === 0) return [unknownTarget]
  return positionals
}

const expansionCwd = (place: ExecutionPlace): string => {
  if (place.unknownCwd) return "$PWD"
  return place.cwd
}

const bindingList = (words: ReadonlyArray<Word>, vars: ReadonlyMap<string, string>, place: ExecutionPlace) =>
  words.reduce((known, entry) => assigned({ ...entry, text: expanded(entry, place, known) }, known), vars)

export const literalPath = (text: string): boolean => !text.includes("\0guard:") && !/[$`*?]/.test(text)

interface Directory {
  readonly cwd: string
  readonly unknownCwd?: true
}

/** An absolute target recovers a known cwd even if its parent scope was dynamic. */
const directoryAt = (at: Directory, target: string): Directory => {
  if (!literalPath(target) || (at.unknownCwd && !target.startsWith("/"))) return { cwd: at.cwd, unknownCwd: true }
  return { cwd: resolve(at.cwd, target) }
}

interface Relevance {
  readonly consumer: boolean
  readonly all: boolean
  readonly names: ReadonlySet<string>
  readonly functions: ReadonlySet<string>
  readonly previousDirectory: boolean
  readonly directoryStack: boolean
}

const allReads: Relevance = { consumer: true, all: true, names: new Set(), functions: new Set(), previousDirectory: true, directoryStack: true }
const stdinRead = "\0stdin"

const readsIn = (words: ReadonlyArray<Word>): ReadonlyArray<string> => words.flatMap((entry) => {
  if (entry.singleQuoted) return []
  // Also sees simple reads in substitutions or parameter defaults.
  return [...entry.text.matchAll(/\$(?:\{([A-Za-z_]\w*|\d+|[@*])(?=[}:?-])|([A-Za-z_]\w*|\d+|[@*]))/g)]
    .map((match) => match[1] || match[2] || "")
})

const dynamicRead = (words: ReadonlyArray<Word>): boolean => words.some((entry) =>
  !entry.singleQuoted && /\$\{(?:[!#]|\$)|\$\{[A-Za-z_]\w*\[/.test(entry.text))

interface ScannedNode {
  readonly node: ShellNode
  readonly upstream: boolean
}

function* shellNodes(body: ShellList, upstream = false, definitions = false): IterableIterator<ScannedNode> {
  for (const { first, links } of body) {
    for (const pipeline of [first, ...links.map(({ pipeline }) => pipeline)]) {
      for (const [index, node] of pipeline.entries()) yield* nestedNodes(node, upstream || index < pipeline.length - 1, definitions)
    }
  }
}

function* nestedNodes(node: ShellNode, upstream: boolean, definitions: boolean): IterableIterator<ScannedNode> {
  yield { node, upstream }
  switch (node.kind) {
    case "group": yield* shellNodes(node.body, upstream, definitions); break
    case "choice":
      for (const { condition, body } of node.arms) {
        yield* shellNodes(condition, upstream, definitions)
        yield* shellNodes(body, upstream, definitions)
      }
      break
    case "loop": yield* shellNodes(node.condition, upstream, definitions); yield* shellNodes(node.body, upstream, definitions); break
    case "redirect": yield* nestedNodes(node.body, upstream, definitions); break
    case "function": if (definitions) yield* nestedNodes(node.body, upstream, definitions); break
    case "command": break
  }
}

interface Reads {
  readonly names: Set<string>
  readonly edges: Map<string, Set<string>>
  readonly depth: number
  readonly functions: Set<string>
  readonly captures: Map<string, ReadonlyArray<ReadonlyArray<Word>>>
  consumer: boolean
  all: boolean
  previousDirectory: boolean
  directoryStack: boolean
}

const dependency = (reads: Reads, name: string, words: ReadonlyArray<Word>, extra: ReadonlyArray<string> = []): void => {
  const previous = reads.edges.get(name) || new Set()
  const calls = capturedCommands(words, reads.captures).map((command) => outputOf(command[0]?.text || ""))
  reads.edges.set(name, new Set([...previous, ...readsIn(words), ...calls, ...extra]))
}

const outputOf = (functionName: string): string => `\0output:${functionName}`

const capturedCommands = (words: ReadonlyArray<Word>, cache: Reads["captures"]): ReadonlyArray<ReadonlyArray<Word>> =>
  words.flatMap((entry) => {
    if (entry.singleQuoted) return []
    const known = cache.get(entry.text)
    if (known) return known
    const commands = Array.from(captureWords(entry.text))
    cache.set(entry.text, commands)
    return commands
  })

function* captureWords(text: string): IterableIterator<ReadonlyArray<Word>> {
  const openings = /\$\(|`/g
  for (let match = openings.exec(text); match; match = openings.exec(text)) {
    const start = openings.lastIndex
    let end = backquoteEnd(text, start)
    if (match[0] === "$(") end = substitutionEnd(text, start)
    for (const { node } of shellNodes(compoundList(text.slice(start, end - 1)))) {
      if (node.kind !== "command") continue
      yield node.words
      for (const word of node.words) if (!word.singleQuoted) yield* captureWords(word.text)
    }
    openings.lastIndex = end
  }
}

const shellWrites = (words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (words.every(({ text }) => assignment.test(text))) return words
  if (words[0]?.text === "export") return words.slice(1).values().filter(({ text }) => assignment.test(text)).toArray()
  return []
}

const analyzeReads = (body: ShellList, depth: number): Relevance => {
  const reads: Reads = {
    names: new Set(), edges: new Map(), consumer: false, all: false, depth,
    functions: new Set(), captures: new Map(), previousDirectory: false, directoryStack: false,
  }
  const definitions = functionDefinitions(body)
  for (const node of reachableNodes(body, definitions, reads).reverse()) scanNodeReads(node, reads)
  for (const name of reads.functions) for (const definition of definitions.get(name) || []) {
    scanFunctionOutput(name, definition, reads)
  }
  if (reads.consumer) reads.names.add("CHROME")
  closeReads(reads)
  return reads
}

const scanNodeReads = ({ node, upstream }: ScannedNode, reads: Reads): void => {
  if (node.kind === "command") {
    scanReads(node.words, reads)
    if (upstream) dependency(reads, stdinRead, node.words)
  }
  if (node.kind === "loop") loopReads(node.header, reads)
  if (node.kind === "redirect") dependency(reads, stdinRead, node.input)
}

const scanFunctionOutput = (name: string, definition: ShellNode, reads: Reads): void => {
  for (const { node } of nestedNodes(definition, false, false)) {
    if (node.kind === "command") dependency(reads, outputOf(name), node.words, [outputOf(node.words[0]?.text || "")])
  }
}

const closeReads = (reads: Reads): void => {
  const pending = [...reads.names]
  for (const name of pending) for (const prerequisite of reads.edges.get(name) || []) {
    if (reads.names.has(prerequisite)) continue
    reads.names.add(prerequisite)
    pending.push(prerequisite)
  }
}

const functionDefinitions = (body: ShellList): ReadonlyMap<string, ReadonlyArray<ShellNode>> => {
  const definitions = new Map<string, ReadonlyArray<ShellNode>>()
  for (const { node } of shellNodes(body, false, true)) {
    if (node.kind === "function") definitions.set(node.name, [...definitions.get(node.name) || [], node.body])
  }
  return definitions
}

const reachableNodes = (body: ShellList, definitions: ReadonlyMap<string, ReadonlyArray<ShellNode>>, reads: Reads): Array<ScannedNode> => {
  const queued = [...shellNodes(body)]
  const seen = new Set<string>()
  for (const { node, upstream } of queued) {
    if (node.kind !== "command") continue
    const calls = [node.words, ...capturedCommands(node.words, reads.captures)]
    for (const words of calls) {
      const name = words[0]?.text || ""
      const matches = definitions.get(name)
      const kind = `${upstream}:${name}`
      if (!matches || seen.has(kind)) continue
      seen.add(kind)
      reads.functions.add(name)
      for (const definition of matches) queued.push(...nestedNodes(definition, upstream, false))
    }
  }
  return queued
}

const loopReads = (header: ReadonlyArray<Word>, reads: Reads): void => {
  const [name, marker, ...values] = header
  if (!name) return
  if (dynamicRead(header)) reads.all = true
  if (marker?.text === "in") dependency(reads, name.text, values)
  else dependency(reads, name.text, [], ["@"])
}

const scanReads = (words: ReadonlyArray<Word>, reads: Reads): void => {
  reads.all ||= dynamicRead(words)
  const writes = shellWrites(words)
  for (const entry of writes) {
    const split = entry.text.indexOf("=")
    dependency(reads, entry.text.slice(0, split), [{ ...entry, text: entry.text.slice(split + 1) }])
  }
  if (writes.length > 0) return
  const read = readArgs(words)
  if (Option.isSome(read)) {
    for (const name of readNames(read.value)) dependency(reads, name, read.value, [stdinRead])
    return
  }
  const invocation = executable(words, [], new Map())
  const [entry, ...args] = invocation.words
  if (words.some(({ text }) => basename(text) === "xargs")) reads.names.add(stdinRead)
  if (entry) commandReads(entry, args, invocation, reads)
}

const commandReads = (entry: Word, args: ReadonlyArray<Word>, invocation: Invocation, reads: Reads): void => {
  const head = basename(entry.text)
  if (head === "export" || endedBuiltin(head)) return
  if (!entry.singleQuoted && !literalPath(entry.text) && /[$`]/.test(entry.text)) reads.all = true
  const selector = head === "git" && isSelector(args)
  const code = codeInputs(head, entry.text, args, invocation.env)
  if (reads.functions.has(head)) {
    dependency(reads, "@", args)
    for (const [index, arg] of args.entries()) dependency(reads, String(index + 1), [arg])
    return
  }
  if (isDirectory(head)) scanDirectoryReads(head, args, reads)
  if (selector || ordinaryConsumer(head, args, code)) reads.consumer = true
  if (head === "source" || head === "." || head === "eval") reads.all = true
  if (head === "find") for (const task of findTasks(args)) scanReads(task, reads)
  for (const input of code) scanCodeReads(input, reads)
  ambientReads(head, selector, reads.names)
  for (const name of readsIn(relevantOperands(head, args, invocation, code, selector))) reads.names.add(name)
}

const ambientReads = (head: string, selector: boolean, names: Set<string>): void => {
  if (head === "node" || head === "nodejs") names.add("NODE_OPTIONS")
  if (!selector) return
  names.add("GIT_DIR")
  names.add("GIT_WORK_TREE")
}

const scanDirectoryReads = (head: string, args: ReadonlyArray<Word>, reads: Reads): void => {
  if (head === "popd") reads.directoryStack = true
  else if (args.some(({ text }) => text === "-" || !literalPath(text))) reads.previousDirectory = true
}

const ordinaryConsumer = (head: string, args: ReadonlyArray<Word>, code: ReadonlyArray<CodeInput>): boolean =>
  !isDirectory(head) && !READERS.has(head) && !syntaxCheck(head, args, code) &&
    !code.some((input) => input.kind === "inline" && input.language === "shell")

const scanCodeReads = (input: CodeInput, reads: Reads): void => {
  if (input.kind === "file" || input.language !== "shell") {
    reads.consumer = true
    reads.all = true
    return
  }
  if (reads.depth >= MAX_CODE_DEPTH) return
  const child = analyzeReads(compoundList(input.code), reads.depth + 1)
  reads.consumer ||= child.consumer
  reads.all ||= child.all
  for (const name of child.names) reads.names.add(name)
}

const endedBuiltin = (head: string): boolean => head === "exit" || head === "return" || head === "break" || head === "continue"

const relevantOperands = (head: string, args: ReadonlyArray<Word>, invocation: Invocation, code: ReadonlyArray<CodeInput>, selector: boolean): ReadonlyArray<Word> => {
  const directory = Option.toArray(Option.map(invocation.directory, word))
  if (selector || isDirectory(head) || head === "find") return [...directory, ...args]
  const positionals = positionalInputs(code, head, args)
  const sources = code.flatMap((input) => {
    if (input.kind === "file") return [input.source]
    return []
  })
  return [...directory, ...runnerReads(head, args), ...sources, ...positionals]
}

const positionalInputs = (code: ReadonlyArray<CodeInput>, head: string, args: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (code.length === 0) return []
  return positionalWords(head, args)
}

export const MAX_PATH_STATES = 64

export interface PathPlan<A> {
  readonly paths: ReadonlyArray<ReadonlyArray<A>>
  readonly witnesses: ReadonlyArray<ReadonlyArray<A>>
  readonly limited: boolean
}

/** Each trace carries the commands which can precede its consumers, in the same path as their shell state. */
export const executionPaths = (line: string, place: ExecutionPlace, depth = -1): PathPlan<Execution> => {
  const body = compoundList(line)
  const reads = analyzeReads(body, depth)
  if (!reads.consumer) return { paths: [[]], witnesses: [], limited: false }
  return projectedPlan(body, place, depth, reads, "guard")
}

const projectedPlan = (body: ShellList, place: ExecutionPlace, depth: number, reads: Relevance, mode: Projection["mode"]): PathPlan<Execution> => {
  const projection: Projection = { ...reads, mode, witnesses: new Map() }
  const { paths, limited } = walkList(body, startFlow(initialState(place, projection)), emptyStream, depth)
  return { paths: paths.map(({ commands }) => commands), witnesses: [...projection.witnesses.values()], limited }
}

export const distinctEntries = <A>(plan: PathPlan<A>): ReadonlyArray<A> => [...new Set([...plan.paths, ...plan.witnesses].flat())]

export const inlineShellPaths = (command: Execution, home: string, code: string): PathPlan<Execution> => {
  const { cwd, unknownCwd, env, positionals, sourceDepth } = command
  if (sourceDepth >= MAX_CODE_DEPTH) return { paths: [[]], witnesses: [], limited: false }
  return executionPaths(code, { cwd, unknownCwd, home, env, positionals }, sourceDepth + 1)
}

/** The command inventory for readers that do not make path-sensitive decisions. */
export const executionPlan = (line: string, place: ExecutionPlace, depth = -1): ReadonlyArray<Execution> =>
  inventory(projectedPlan(compoundList(line), place, depth, allReads, "inventory"), place.home)

const inventory = (plan: PathPlan<Execution>, home: string): ReadonlyArray<Execution> =>
  distinctEntries(plan).flatMap((command) => {
    const commands = [command]
    for (const input of command.code) {
      if (input.kind !== "inline" || input.language !== "shell" || command.sourceDepth >= MAX_CODE_DEPTH) continue
      const { cwd, env, unknownCwd, positionals, sourceDepth } = command
      commands.push(...executionPlan(input.code, { cwd, home, env, unknownCwd, positionals }, sourceDepth + 1))
    }
    return commands
  })

interface Projection extends Relevance {
  readonly mode: "inventory" | "guard"
  readonly witnesses: Map<string, ReadonlyArray<Execution>>
}

const relevant = (projection: Relevance, name: string): boolean => projection.all || projection.names.has(name)
const projectNames = <A>(map: ReadonlyMap<string, A>, projection: Relevance): ReadonlyMap<string, A> => {
  if (projection.all) return map
  return new Map(map.entries().filter(([key]) => relevant(projection, key)))
}

const initialState = (place: ExecutionPlace, projection: Projection): ShellState => {
  const env = projectNames(place.env || new Map<string, string>(), projection)
  const bindings = projectNames(initialBindings(place.positionals || []), projection)
  return { projection, place: { ...place, env }, vars: env, bindings, directories: [], loops: [], functions: new Map(), calls: [] }
}

interface Stream {
  readonly history: boolean
  readonly words: ReadonlyArray<Word>
}
const emptyStream: Stream = { history: false, words: [] }
const streamWords = (stream: Stream): ReadonlyArray<Word> => {
  if (stream.history) return [word(historyTarget)]
  return stream.words
}

type Status = "next" | "yes" | "no" | "failure" | "dead" | "exit" | "return" | "break" | "continue"
interface WalkPath extends ExecutionStep {
  readonly output: Stream
  readonly capture: boolean
  readonly status: Status
}
interface Flow {
  readonly paths: ReadonlyArray<WalkPath>
  readonly limited: boolean
}
const onePath = (path: WalkPath): Flow => ({ paths: [path], limited: false })
const startFlow = (state: ShellState, capture = false): Flow => onePath({ ...emptyStep(state), output: emptyStream, status: "next", capture })
const resume = (path: WalkPath): WalkPath => ({ ...path, status: "next" })
const ended = ({ status }: WalkPath): boolean => status !== "next" && status !== "yes" && status !== "no" && status !== "failure"

const flowFrom = (paths: ReadonlyArray<WalkPath>, limited: boolean): Flow => {
  if (paths.length < 2) return { paths, limited }
  const unique = new Map<string, WalkPath>()
  let count = 0
  for (const path of paths) {
    const key = pathKey(path)
    const known = unique.get(key)
    if (known) {
      rememberWitness(known.commands, path)
      continue
    }
    if (!ended(path)) count += 1
    if (count > MAX_PATH_STATES) return { paths: [...unique.values()], limited: true }
    unique.set(key, path)
  }
  return { paths: [...unique.values()], limited }
}

// Length-delimited keys preserve arbitrary shell literals, including control characters.
const tuple = (parts: Iterable<string>): string => Array.from(parts, (part) => `${part.length}:${part}`).join("")
const mapKey = <A>(entries: ReadonlyMap<string, A>, encode: (value: A) => string): string =>
  tuple([...entries].map(([key, value]) => tuple([key, encode(value)])).sort())
const identity = (value: string): string => value
const dirKey = (place: Directory): string => tuple([place.cwd, String(Boolean(place.unknownCwd))])
const optionText = (value: Option.Option<string>): string => Option.getOrElse(value, () => "")

const execKey = (command: Execution): string => tuple([
  command.head, command.command, dirKey(command), mapKey(command.env, identity), tuple(command.positionals),
  tuple(command.args.map(wordKey)), encodeSyntax(command.code), String(command.syntaxOnly),
])

const actionKey = (action: ReturnType<typeof gitAction>): string => tuple([
  action.revision, optionText(action.tree), action.bisectMode || "",
  String(Boolean(action.explicitTree)), String(Boolean(action.newTree)),
])

interface SelectionEffect {
  readonly key: string
  readonly ordered: boolean
}

/** A symbolic per-tree effect, before the I/O layer resolves checkout-root aliases. */
const selectionEffect = (command: Execution): Option.Option<SelectionEffect> => {
  if (command.code.length > 0) return Option.some({ key: tuple(["child", execKey(command)]), ordered: true })
  if (command.head !== "git") return Option.none()
  const args = command.args.map(({ text }) => text)
  const action = gitAction(command.head, args, command)
  if (action.rebaseExec || (!action.bisectMode && action.revision !== "moves" && action.revision !== "unknown")) return Option.none()
  const refs = gitAction(command.head, args, command, () => true)
  const key = actionKey(action)
  const inRefs = actionKey(refs)
  return Option.some({ key: tuple(["tree", key, inRefs]), ordered: Boolean(action.bisectMode) || key !== inRefs })
}

const selectionKey = (commands: ReadonlyArray<Execution>): string => {
  const record: Array<string> = []
  const writes = new Set<string>()
  for (const command of commands) {
    const effect = selectionEffect(command)
    if (Option.isNone(effect)) continue
    if (!effect.value.ordered) {
      writes.add(effect.value.key)
      continue
    }
    // Ordinary changes commute and are idempotent. Child execution and bisect
    // modes are barriers: later operations can read their tree effects.
    record.push(tuple([...writes].sort()), effect.value.key)
    writes.clear()
  }
  return tuple([...record, tuple([...writes].sort())])
}

const encodeSyntax = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const wordKey = (entry: Word): string => tuple([entry.text, String(entry.bareStart), String(entry.singleQuoted)])
const previousKey = (state: ShellState): string => {
  if (!state.previous || (!state.projection.all && !state.projection.previousDirectory)) return ""
  return dirKey(state.previous)
}

const stackKey = (state: ShellState): string => {
  if (!state.projection.all && !state.projection.directoryStack) return ""
  return tuple(state.directories.map(dirKey))
}

const pathKey = ({ state, commands, output, capture, status }: WalkPath): string => {
  const shell = tuple([
    dirKey(state.place), stackKey(state), previousKey(state),
    mapKey(state.vars, identity), mapKey(state.place.env || new Map(), identity),
    mapKey(state.bindings, (values) => tuple([...new Set(values)].sort())),
    mapKey(state.functions, encodeSyntax), tuple(state.calls), tuple(state.loops.map(String)),
  ])
  const observation = tuple([String(capture), String(output.history), tuple(output.words.map(wordKey))])
  let effects = selectionKey(commands)
  if (state.projection.mode === "inventory") effects = tuple(commands.map(execKey))
  return tuple([status, shell, observation, effects])
}

const rememberWitness = (known: ReadonlyArray<Execution>, path: WalkPath): void => {
  if (path.commands === known) return
  const key = tuple(path.commands.map(execKey))
  if (key === tuple(known.map(execKey))) return
  path.state.projection.witnesses.set(key, path.commands)
}

const advance = (flow: Flow, step: (path: WalkPath) => Flow): Flow => {
  if (flow.limited) return flow
  const paths: Array<WalkPath> = []
  let limited = false
  for (const path of flow.paths) {
    const run = step(path)
    paths.push(...run.paths)
    limited ||= run.limited
  }
  return flowFrom(paths, limited)
}

const walkList = (body: ShellList, start: Flow, input: Stream, depth: number): Flow =>
  body.reduce((flow, chain) => advance(flow, (path) => walkChain(chain, path, input, depth)), start)

const walkChain = ({ first, links }: ShellChain, path: WalkPath, input: Stream, depth: number): Flow => {
  if (ended(path)) return onePath(path)
  let flow = walkPipeline(first, resume(path), input, depth)
  for (const { on, pipeline } of links) {
    flow = advance(flow, (prior) => {
      if (ended(prior)) return onePath(prior)
      if (prior.status === "next") return splitLink(prior, on, pipeline, input, depth)
      if ((on === "&&") === (prior.status === "yes")) return walkPipeline(pipeline, resume(prior), input, depth)
      return onePath(prior)
    })
  }
  return advance(flow, (prior) => {
    if (prior.status === "yes" || prior.status === "no") return onePath(resume(prior))
    return onePath(prior)
  })
}

const splitLink = (path: WalkPath, on: "&&" | "||", pipeline: ReadonlyArray<ShellNode>, input: Stream, depth: number): Flow => {
  const run = walkPipeline(pipeline, path, input, depth)
  let skipped: Status = "yes"
  if (on === "&&") skipped = "no"
  return flowFrom([{ ...path, status: skipped }, ...run.paths], run.limited)
}

const mergeStreams = (left: Stream, right: Stream): Stream => ({
  history: left.history || right.history,
  words: [...left.words, ...right.words],
})

/** Pipe stages share data and the execution trace, not their local shell bindings. */
const walkPipeline = (pipeline: ReadonlyArray<ShellNode>, start: WalkPath, input: Stream, depth: number): Flow => {
  let flow = onePath({ ...start, output: input })
  for (const [index, node] of pipeline.entries()) {
    flow = advance(flow, (prior) => {
      const run = walkNode(node, { ...prior, capture: start.capture || index < pipeline.length - 1, output: emptyStream }, prior.output, depth)
      return { ...run, paths: run.paths.map((path) => pipeResult(path, prior, keepsState(pipeline.length, index, node))) }
    })
  }
  return { ...flow, paths: flow.paths.map((path) => ({ ...path, capture: start.capture, output: capturedOutput(start, path) })) }
}

const capturedOutput = (start: WalkPath, path: WalkPath): Stream => {
  if (!start.capture) return emptyStream
  return mergeStreams(start.output, path.output)
}

const pipeResult = (path: WalkPath, prior: WalkPath, local: boolean): WalkPath => {
  const output = { ...path.output, history: prior.output.history || path.output.history }
  if (local) return { ...path, output }
  return { ...resume(path), state: prior.state, output }
}

// Keep the accepted direct read handoff; a grouped stage's shell state stays local.
const keepsState = (length: number, index: number, node: ShellNode): boolean =>
  length === 1 || (index === length - 1 && node.kind === "command" && Option.isSome(readArgs(node.words)))

const walkNode = (node: ShellNode, path: WalkPath, input: Stream, depth: number): Flow => {
  const { state } = path
  switch (node.kind) {
    case "command": return walkCommand(node.words, path, input, depth)
    case "group": {
      const run = walkList(node.body, onePath(path), input, depth)
      if (node.local) return { ...run, paths: run.paths.map((next) => ({ ...resume(next), state })) }
      return run
    }
    case "function": return declareFunction(node, path)
    case "redirect": {
      const run = walkNode(node.body, path, redirectedStream(node.input, state, input), depth)
      if (capturesStdout(node.input)) return run
      return { ...run, paths: run.paths.map((next) => ({ ...next, output: path.output })) }
    }
    case "loop": return walkLoop(node, path, input, depth)
    case "choice": return walkChoice(node, path, input, depth)
  }
}

const declareFunction = (node: Extract<ShellNode, { kind: "function" }>, path: WalkPath): Flow => {
  const { state } = path
  if (!state.projection.all && !state.projection.functions.has(node.name)) return onePath(path)
  return onePath({ ...path, state: { ...state, functions: new Map([...state.functions, [node.name, node.body]]) } })
}

const walkChoice = (node: Extract<ShellNode, { kind: "choice" }>, path: WalkPath, input: Stream, depth: number): Flow => {
  let pending = onePath(path)
  const paths: Array<WalkPath> = []
  let limited = false
  for (const arm of node.arms) {
    const condition = walkList(arm.condition, pending, input, depth)
    const live = condition.paths.values().filter((prior) => !ended(prior)).map(resume).toArray()
    const body = walkList(arm.body, { ...condition, paths: live }, input, depth)
    paths.push(...condition.paths.values().filter(ended), ...body.paths.map(armEnd))
    limited ||= body.limited
    if (limited) break
    pending = { ...condition, paths: live }
  }
  if (!node.exhaustive && !limited) paths.push(...pending.paths)
  return flowFrom(paths, limited)
}

const armEnd = (path: WalkPath): WalkPath => {
  if (path.status === "failure") return { ...path, status: "dead" }
  return path
}

interface ShellState {
  readonly projection: Projection
  readonly place: ExecutionPlace
  readonly vars: ReadonlyMap<string, string>
  readonly bindings: Bindings
  readonly loops: ReadonlyArray<number>
  readonly functions: ReadonlyMap<string, ShellNode>
  readonly calls: ReadonlyArray<string>
  readonly directories: ReadonlyArray<Directory>
  readonly previous?: Directory
}

interface ExecutionStep {
  readonly state: ShellState
  readonly commands: ReadonlyArray<Execution>
}

const loopName = /^[A-Za-z_]\w*$/
const emptyStep = (state: ShellState): ExecutionStep => ({ state, commands: [] })
const withBinding = (state: ShellState, name: string, values: Alternatives): ExecutionStep =>
  emptyStep(relevantBinding(state, name, values))

const relevantBinding = (state: ShellState, name: string, values: Alternatives): ShellState => {
  if (!relevant(state.projection, name)) return state
  return { ...state, bindings: new Map([...state.bindings, [name, values]]) }
}

const loopWords = (words: ReadonlyArray<Word>, state: ShellState): Alternatives =>
  words.flatMap((entry) => {
    if (entry.bareStart && /[*?[\]]/.test(entry.text)) return [unknownTarget]
    return alternatives(entry, state)
  })

const loopBinding = (state: ShellState, name: string, values: Alternatives): ExecutionStep => {
  const id = Arr.head(state.loops)
  if (Option.isNone(id)) return withBinding(state, name, values)
  return withBinding(state, name, values.map((value) => value.replaceAll(unknownTarget, loopMarker(id.value))))
}

const activeTarget = (value: string, loops: ReadonlyArray<number>): string =>
  value.replace(iterationTarget, (_marker, id: string) => producerValue(loops.includes(Number(id))))

const loopRead = (args: ReadonlyArray<Word>, piped: ReadonlyArray<Word>, state: ShellState): ExecutionStep => {
  const redirection = args.findIndex((entry) => entry.bareStart && /^[<>]/.test(entry.text))
  const names = readNames(args)
  const values = readValues(args, redirection, piped, state)
  if (names.length < 2) return loopBinding(state, names[0] || "REPLY", values)
  const uncertain = producerValue(values.some((value) => value.includes(historyTarget)))
  return names.reduce(({ state: current }, name) => loopBinding(current, name, [uncertain]), emptyStep(state))
}

const readNames = (args: ReadonlyArray<Word>): ReadonlyArray<string> => {
  const redirection = args.findIndex((entry) => entry.bareStart && /^[<>]/.test(entry.text))
  const names = args.slice(0, readArgumentEnd(redirection, args.length)).values().filter((entry) => loopName.test(entry.text)).map(({ text }) => text).toArray()
  if (names.length === 0) return ["REPLY"]
  return names
}

const readValues = (args: ReadonlyArray<Word>, redirection: number, piped: ReadonlyArray<Word>, state: ShellState): Alternatives => {
  const source = args[redirection + 1]
  if (args[redirection]?.text === "<<<" && source) return loopWords([source], state).flatMap((value) => value.split(/\r?\n/))
  if (redirection >= 0 || piped.length === 0) return [unknownTarget]
  return loopWords(piped, state).flatMap((value) => value.split(/\r?\n/))
}

const readArgumentEnd = (redirection: number, length: number): number => {
  if (redirection < 0) return length
  return redirection
}

const readArgs = (words: ReadonlyArray<Word>): Option.Option<ReadonlyArray<Word>> => {
  const command = words.findIndex((entry) => !assignment.test(entry.text))
  if (words[command]?.text === "read") return Option.some(words.slice(command + 1))
  return Option.none()
}

const walkLoop = (node: Extract<ShellNode, { kind: "loop" }>, path: WalkPath, input: Stream, depth: number): Flow => {
  const { state } = path
  const scoped = { ...state, loops: [node.id, ...state.loops] }
  const iteration = bindIteration(node.header, scoped)
  const condition = walkList(node.condition, onePath({ ...path, state: iteration }), input, depth)
  const body = advance(condition, (prior) => {
    if (ended(prior)) return onePath(prior)
    const next = { ...resume(prior), state: conditionBindings(prior.state, iteration, node.id) }
    return walkList(node.body, onePath(next), input, depth)
  })
  const zero = loopSkip(node.header, path, condition.paths)
  return flowFrom([...zero, ...body.paths.map((prior) => loopEnd(prior, state.loops))], body.limited)
}

const loopSkip = (header: ReadonlyArray<Word>, entry: WalkPath, condition: ReadonlyArray<WalkPath>): ReadonlyArray<WalkPath> => {
  if (header.length > 0) return [entry]
  return condition.values().filter((prior) => !ended(prior)).map((prior) => loopEnd(resume(prior), entry.state.loops)).toArray()
}

const loopEnd = (path: WalkPath, loops: ReadonlyArray<number>): WalkPath => {
  const scoped = { ...path, state: { ...path.state, loops } }
  if (path.status === "break" || path.status === "continue") return resume(scoped)
  return armEnd(scoped)
}

const conditionBindings = (after: ShellState, before: ShellState, id: number): ShellState => {
  const bindings = new Map(after.bindings)
  for (const [name, values] of after.bindings) {
    if (values !== before.bindings.get(name)) bindings.set(name, values.map((value) => value.replaceAll(unknownTarget, loopMarker(id))))
  }
  return { ...after, bindings }
}

const bindIteration = (header: ReadonlyArray<Word>, state: ShellState): ShellState => {
  const [name, inWord, ...values] = header
  if (!name || !loopName.test(name.text)) return state
  if (inWord?.text === "in") return loopBinding(state, name.text, loopWords(values, state)).state
  return loopBinding(state, name.text, positionalList(state.place.positionals || [])).state
}

const redirectedStream = (args: ReadonlyArray<Word>, state: ShellState, prior: Stream): Stream => {
  const [op, value] = args
  if (op?.text === "<<<" && value) {
    const lines = alternatives(value, state).flatMap((entry) => entry.split(/\r?\n/))
    return outputValues(lines)
  }
  if (op?.text.startsWith("<")) return emptyStream
  return prior
}

const outputValues = (values: Alternatives): Stream => ({
  history: values.some((value) => value.includes(historyTarget)),
  words: values.map(word),
})

const walkCommand = (words: ReadonlyArray<Word>, path: WalkPath, input: Stream, depth: number): Flow => {
  const { state } = path
  const read = readArgs(words)
  if (Option.isSome(read)) return onePath({ ...path, state: loopRead(read.value, streamWords(input), state).state })
  const [head, ...args] = words
  const body = state.functions.get(head?.text || "")
  if (body && head) return callFunction(head.text, body, args, path, input, depth)
  const text = words.find((entry) => !assignment.test(entry.text))?.text || ""
  const status = commandStatus(text, args)
  if (status !== "next" && text !== "exec") return onePath({ ...path, status })
  const run = executionStep(words, streamWords(input), state, depth)
  const output = commandOutput(words, state, run.commands)
  const observations = run.commands.values().filter((command) => tracksCommand(command, state.projection)).toArray()
  return onePath({ ...path, status, state: run.state, commands: [...path.commands, ...observations], output })
}

const tracksCommand = (command: Execution, projection: Projection): boolean => {
  if (projection.mode === "inventory" || command.code.length > 0) return true
  if (command.head === "git") return isSelector(command.args)
  return !READERS.has(command.head) && !command.syntaxOnly
}

const commandStatus = (head: string, args: ReadonlyArray<Word>): Status => {
  if (head === "exit" || head === "return" || head === "break" || head === "continue") return head
  if (head === "exec" && args.some(({ text }) => !/^(?:[<>]|\d+[<>])/.test(text))) return "exit"
  if (head === "false") return "failure"
  return "next"
}

const callFunction = (name: string, body: ShellNode, args: ReadonlyArray<Word>, path: WalkPath, input: Stream, depth: number): Flow => {
  const caller = path.state
  if (caller.calls.includes(name)) return onePath(path)
  const positionals = shellPositionals("function", args, caller)
  const bindings = projectNames(withPositionals(caller.bindings, initialBindings(positionals)), caller.projection)
  const frame = { ...caller, place: { ...caller.place, positionals }, bindings, calls: [...caller.calls, name] }
  const run = walkNode(body, { ...path, state: frame }, input, depth)
  return { ...run, paths: run.paths.map((prior) => returnToCaller(prior, caller)) }
}

const returnToCaller = (path: WalkPath, caller: ShellState): WalkPath => {
  const { state } = path
  const bindings = withPositionals(state.bindings, caller.bindings)
  const next = { ...path, state: { ...state, place: { ...state.place, positionals: caller.place.positionals }, bindings, calls: caller.calls } }
  if (path.status === "return") return resume(next)
  return next
}

const isPositional = (key: string): boolean => /^\d+$|^@$/.test(key)
const withPositionals = (target: Bindings, source: Bindings): Bindings => {
  const bindings = new Map(target)
  for (const key of bindings.keys()) {
    if (isPositional(key)) bindings.delete(key)
  }
  for (const [key, value] of source) {
    if (isPositional(key)) bindings.set(key, value)
  }
  return bindings
}

const commandOutput = (words: ReadonlyArray<Word>, state: ShellState, commands: ReadonlyArray<Execution>): Stream => {
  if (commands.length === 0 || !capturesStdout(words)) return emptyStream
  const history = producesHistory(words) || words.some((entry) =>
    alternatives(entry, state).some((value) => activeTarget(value, state.loops).includes(historyTarget)))
  return { history, words: literalInput(words) }
}

// Track descriptor aliases in redirection order: 2>&1 >&2 still captures stdout,
// whereas >&2 2>&1 leaves both descriptors pointing at the original stderr.
const capturesStdout = (words: ReadonlyArray<Word>): boolean => {
  let stdout = true
  let stderr = false
  for (const [index, entry] of words.entries()) {
    if (!entry.bareStart) continue
    const redirect = /^(?<fd>[12]?)>>?(?<target>.*)$/.exec(entry.text)?.groups
    if (!redirect) continue
    let target = redirect.target || words[index + 1]?.text
    if (target === "&") target += words[index + 1]?.text || ""
    const captured: boolean = (target === "&1" && stdout) || (target === "&2" && stderr)
    if (redirect.fd === "2") stderr = captured
    else stdout = captured
  }
  return stdout
}

const changeDirectory = (head: string, args: ReadonlyArray<Word>, state: ShellState): ShellState => {
  const { place, vars, directories } = state
  if (head === "popd") {
    const [top, ...after] = directories
    if (!top) return state
    return { ...state, directories: after, previous: place, place: { home: place.home, env: place.env, ...top } }
  }
  const marker = args[0]?.text === "--" || args[0]?.text === "-L" || args[0]?.text === "-P"
  const target = expanded(args[Number(marker)] || word(place.home), place, vars)
  const moved = moveDirectory(place, state.previous, target)
  const next = { ...state, previous: place, place: { home: place.home, env: place.env, ...moved } }
  if (head === "pushd") return { ...next, directories: [place, ...directories] }
  return next
}

const moveDirectory = (place: ExecutionPlace, previous: Directory | void, target: string): Directory => {
  if (target !== "-") return directoryAt(place, target)
  return previous || { cwd: place.cwd, unknownCwd: true }
}

const executionStep = (words: ReadonlyArray<Word>, piped: ReadonlyArray<Word>, state: ShellState, sourceDepth: number): ExecutionStep => {
  const { place, vars } = state
  const env = place.env || new Map<string, string>()
  const idle: ExecutionStep = { state, commands: [] }
  const [first, ...rest] = words
  if (words.every(({ text }) => assignment.test(text))) {
    const assigned = assignments(state, words)
    // An assignment to an exported CHROME changes the value inherited by later launchers.
    const chrome = Option.fromUndefinedOr(assigned.vars.get("CHROME"))
    if (env.has("CHROME") && Option.isSome(chrome))
      return emptyStep({ ...assigned, place: { ...place, env: new Map([...env, ["CHROME", chrome.value]]) } })
    return emptyStep(assigned)
  }
  if (first?.text === "export" && rest.every(({ text }) => assignment.test(text) || /^[A-Za-z_]\w*$/.test(text))) {
    const assigned = assignments(state, rest.values().filter(({ text }) => assignment.test(text)).toArray())
    const exported = rest.map(({ text }) => text.split("=", 1)[0] || "")
    return emptyStep({ ...assigned, place: { ...place, env: new Map([...env, ...Array.from(assigned.vars).filter(([key]) => exported.includes(key))]) } })
  }
  const invocation = executable(words, piped, env)
  const [entry, ...args] = invocation.words
  if (!entry) return idle
  const head = basename(entry.text)
  if (isDirectory(head)) return { ...idle, state: changeDirectory(head, args, state) }
  const at = Option.getOrElse(Option.map(invocation.directory, (directory) => directoryAt(place, expanded(word(directory), place, vars))), () => place)
  const runAt = runnerDirectory(head, args, { ...place, ...at }, vars)
  const code = codeInputs(head, entry.text, args, invocation.env).map((input): CodeInput => {
    if (input.kind === "inline") return input
    return { ...input, source: { ...input.source, text: expanded(input.source, runAt, vars) } }
  })
  const syntaxOnly = syntaxCheck(head, args, code)
  const positionals = codePositionals(code, head, args, state)
  const command = { head, command: invocation.words.map(({ text }) => text).join(" "), cwd: runAt.cwd, unknownCwd: runAt.unknownCwd, env: projectNames(invocation.env, state.projection), code, sourceDepth, syntaxOnly, positionals }
  if (head === "git") return { state, commands: gitArgv(args, { ...place, ...at }, state).map((actual) => ({ ...command, args: actual })) }
  // Keep the command observation, but do not let subsequent launches inherit an unset shim.
  if (first?.text === "unset" && unsetsChrome(rest))
    return { state: clearChrome(state, env), commands: [{ ...command, args }] }
  if (head !== "find") return { state, commands: [{ ...command, args }] }
  const tasks = findTasks(args).flatMap((task) => executionStep(task, [], { ...state, place: runAt }, sourceDepth).commands)
  return { state, commands: [{ ...command, args }, ...tasks] }
}

const unsetsChrome = (args: ReadonlyArray<Word>): boolean => {
  for (const { text } of args) {
    if (text === "--" || !text.startsWith("-")) break
    if (text.includes("f")) return false // unset -f removes a function, not the variable.
  }
  return args.some(({ text }) => text === "CHROME")
}

const clearChrome = (state: ShellState, env: ReadonlyMap<string, string>): ShellState => {
  const vars = new Map(state.vars)
  const bindings = new Map(state.bindings)
  const exported = new Map(env)
  vars.delete("CHROME")
  bindings.delete("CHROME")
  exported.delete("CHROME")
  return { ...state, vars, bindings, place: { ...state.place, env: exported } }
}

const codePositionals = (code: ReadonlyArray<CodeInput>, head: string, args: ReadonlyArray<Word>, state: ShellState): ReadonlyArray<string> => {
  if (code.length === 0) return []
  return shellPositionals(head, args, state)
}

const findTasks = (args: ReadonlyArray<Word>): ReadonlyArray<ReadonlyArray<Word>> => {
  const tasks: Array<ReadonlyArray<Word>> = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.text !== "-exec") continue
    const task = Arr.takeWhile(args.slice(index + 1), (entry) => entry.text !== ";" && entry.text !== "+")
    if (index + 1 + task.length >= args.length) break
    index += task.length + 1
    tasks.push(task.map((entry) => ({ ...entry, text: entry.text.replaceAll("{}", historyTarget) })))
  }
  return tasks
}

const assignments = (state: ShellState, words: ReadonlyArray<Word>): ShellState => {
  const kept = words.values().filter(({ text }) => relevant(state.projection, text.slice(0, text.indexOf("=")))).toArray()
  if (kept.length === 0) return state
  return {
    ...state,
    vars: bindingList(kept, state.vars, state.place),
    bindings: kept.reduce((bindings, entry) => bind(entry, { ...state, bindings }), state.bindings),
  }
}

const gitArgv = (args: ReadonlyArray<Word>, place: ExecutionPlace, state: ShellState): ReadonlyArray<ReadonlyArray<Word>> =>
  args.reduce<ReadonlyArray<ReadonlyArray<Word>>>((rows, arg) => {
    const values = alternatives(arg, { ...state, place }).map((text) => ({ ...arg, text: activeTarget(text, state.loops) }))
    return rows.flatMap((row) => values.map((value) => [...row, value]))
  }, [[]])

const shellPositionals = (head: string, args: ReadonlyArray<Word>, state: ShellState): ReadonlyArray<string> => {
  const words = positionalWords(head, args)
  return words.map((arg) => activeTarget(singleValue(alternatives(arg, state)), state.loops))
}

const positionalWords = (head: string, args: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (!SHELLS.has(head)) return args
  const input = shellInput(args)
  return input.operands.slice(1 + Number(input.command))
}

const singleValue = (values: Alternatives): string => {
  if (values.length !== 1) return unknownTarget
  return values[0] || ""
}

/** Location options belong to the invoked program, not to the surrounding shell. */
const runnerDirectory = (head: string, args: ReadonlyArray<Word>, place: ExecutionPlace, vars: ReadonlyMap<string, string>): ExecutionPlace => {
  let directory = place
  for (const move of runnerMoves(head, args)) {
    const target = expanded(move.directory, place, vars)
    directory = { ...place, ...runnerDestination(head, move.kind, directory, place, target) }
  }
  return directory
}

const runnerReads = (head: string, args: ReadonlyArray<Word>): ReadonlyArray<Word> =>
  Array.from(runnerMoves(head, args), ({ directory }) => directory)

function* runnerMoves(head: string, args: ReadonlyArray<Word>): IterableIterator<{ readonly directory: Word; readonly kind: OptionKind | void }> {
  const options = launcherOptions.get(head) || runtimeOptions.get(head)
  if (!options) return
  let consume = false
  for (const [index, entry] of args.entries()) {
    if (consume) {
      consume = false
      continue
    }
    if (entry.text === "--") break
    if (!entry.text.startsWith("-") && head === "bun" && !bunCommands.has(entry.text)) break
    const move = runnerOption(entry, args[index + 1] || word(""), options)
    if (move.stop) break
    consume = move.consume
    if (Option.isSome(move.directory)) {
      yield { directory: move.directory.value, kind: move.kind }
    }
  }
}

const runnerOption = (entry: Word, next: Word, table: Options) => {
  const item = flag(entry, table)
  const kind = table.get(item.name)
  const consume = Boolean(kind && kind !== "flag" && Option.isNone(item.attached))
  const stop = kind === "code" || kind === "stop" || kind === "check"
  const directory = Option.getOrElse(item.attached, () => next)
  return { kind, consume, stop, directory: Option.liftPredicate(directory, () => kind === "directory" || kind === "manifest") }
}

const runnerDestination = (head: string, kind: OptionKind | void, previous: Directory, place: Directory, target: string): Directory => {
  if (kind === "manifest" && literalPath(target)) return directoryAt(place, dirname(target))
  if (head === "make") return directoryAt(previous, target)
  return directoryAt(place, target)
}

const syntaxCheck = (head: string, args: ReadonlyArray<Word>, code: ReadonlyArray<CodeInput>): boolean => {
  if (SHELLS.has(head)) return shellInput(args).noexec
  if (code.length > 0) return false
  if (head === "node" || head === "nodejs") return args.some(({ text }) => text === "--check" || text === "-c")
  return head === "deno" && args[0]?.text === "check"
}

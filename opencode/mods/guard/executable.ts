// The keychain reader's execution plan. Wrapper options locate the next
// executable; runtime options say which code runs before its entry point.
import { Array as Arr, Option } from "effect"
import { compoundList, type ShellList, type ShellNode } from "./compound.ts"
import { basename, dirname, resolve } from "./path.ts"
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
  const stream = walkList(compoundList(text.slice(start, end - 1)), state, emptyStream, MAX_CODE_DEPTH).output
  return { end, value: producerValue(stream.history) }
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

/** Commands and their ordered source inputs, including inline shell commands in their actual execution position. */
export const executionPlan = (line: string, place: ExecutionPlace, depth = -1): ReadonlyArray<Execution> =>
  walkList(compoundList(line), initialState(place), emptyStream, depth).commands

const initialState = (place: ExecutionPlace): ShellState => {
  const env = place.env || new Map<string, string>()
  return { place: { ...place, env }, vars: env, bindings: initialBindings(place.positionals || []), directories: [], loops: [], functions: new Map(), calls: [] }
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

interface WalkStep extends ExecutionStep {
  readonly output: Stream
}

const walkList = (body: ShellList, start: ShellState, input: Stream, depth: number): WalkStep => {
  let state = start
  let output = emptyStream
  const commands: Array<Execution> = []
  for (const pipeline of body) {
    const run = walkPipeline(pipeline, state, input, depth)
    state = run.state
    output = mergeStreams(output, run.output)
    commands.push(...run.commands)
  }
  return { state, output, commands }
}

const mergeStreams = (left: Stream, right: Stream): Stream => ({
  history: left.history || right.history,
  words: [...left.words, ...right.words],
})

/** The mark on stdin survives every pipe stage, independent of its executable. */
const walkPipeline = (pipeline: ReadonlyArray<ShellNode>, state: ShellState, input: Stream, depth: number): WalkStep => {
  const commands: Array<Execution> = []
  let stream = input
  let next = state
  for (const [index, node] of pipeline.entries()) {
    const run = walkNode(node, state, stream, depth)
    commands.push(...run.commands)
    stream = { ...run.output, history: stream.history || run.output.history }
    if (keepsState(pipeline.length, index, node)) next = run.state
  }
  return { state: next, commands, output: stream }
}

// Keep the accepted direct read handoff; a grouped stage's shell state stays local.
const keepsState = (length: number, index: number, node: ShellNode): boolean =>
  length === 1 || (index === length - 1 && node.kind === "command" && Option.isSome(readArgs(node.words)))

const walkNode = (node: ShellNode, state: ShellState, input: Stream, depth: number): WalkStep => {
  switch (node.kind) {
    case "command": return walkCommand(node.words, state, input, depth)
    case "group": {
      const run = walkList(node.body, state, input, depth)
      if (node.local) return { ...run, state }
      return run
    }
    case "function": return { ...emptyStep({ ...state, functions: new Map([...state.functions, [node.name, node.body]]) }), output: emptyStream }
    case "redirect": return walkNode(node.body, state, redirectedStream(node.input, state, input), depth)
    case "loop": return walkLoop(node, state, input, depth)
    case "choice": return walkChoice(node, state, input, depth)
  }
}

const walkChoice = (node: Extract<ShellNode, { kind: "choice" }>, state: ShellState, input: Stream, depth: number): WalkStep => {
  let conditionState = state
  let output = emptyStream
  const commands: Array<Execution> = []
  const branches: Array<ShellState> = []
  for (const arm of node.arms) {
    const condition = walkList(arm.condition, conditionState, input, depth)
    const body = walkList(arm.body, condition.state, input, depth)
    output = mergeStreams(output, mergeStreams(condition.output, body.output))
    commands.push(...condition.commands, ...body.commands)
    conditionState = condition.state
    branches.push(body.state)
  }
  const after = branches.at(-1) || conditionState
  return { state: { ...after, bindings: joinBindings([conditionState, ...branches]) }, output, commands }
}

const joinBindings = (frames: ReadonlyArray<ShellState>): Bindings => {
  const names = new Set(frames.flatMap(({ bindings }) => Array.from(bindings.keys())))
  return new Map(Array.from(names, (name) => [name, [...new Set(frames.flatMap(({ bindings }) => bindings.get(name) || [unknownTarget]))]]))
}

interface ShellState {
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
  emptyStep({ ...state, bindings: new Map([...state.bindings, [name, values]]) })

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
  const names = args.slice(0, readArgumentEnd(redirection, args.length)).values().filter((entry) => loopName.test(entry.text)).map(({ text }) => text).toArray()
  const values = readValues(args, redirection, piped, state)
  if (names.length < 2) return loopBinding(state, names[0] || "REPLY", values)
  const uncertain = producerValue(values.some((value) => value.includes(historyTarget)))
  return names.reduce(({ state: current }, name) => loopBinding(current, name, [uncertain]), emptyStep(state))
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

const walkLoop = (node: Extract<ShellNode, { kind: "loop" }>, state: ShellState, input: Stream, depth: number): WalkStep => {
  const scoped = { ...state, loops: [node.id, ...state.loops] }
  const iteration = bindIteration(node.header, scoped)
  const condition = walkList(node.condition, iteration, input, depth)
  const body = walkList(node.body, conditionBindings(condition.state, iteration, node.id), input, depth)
  return { state: { ...body.state, loops: state.loops }, output: mergeStreams(condition.output, body.output), commands: [...condition.commands, ...body.commands] }
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

const walkCommand = (words: ReadonlyArray<Word>, state: ShellState, input: Stream, depth: number): WalkStep => {
  const read = readArgs(words)
  if (Option.isSome(read)) return { ...loopRead(read.value, streamWords(input), state), output: emptyStream }
  const [head, ...args] = words
  const body = state.functions.get(head?.text || "")
  if (body && head) return callFunction(head.text, body, args, state, input, depth)
  if (head?.text === "break" || head?.text === "continue" || head?.text === "return") return { ...emptyStep(state), output: emptyStream }
  const run = executionStep(words, streamWords(input), state, depth)
  const commands = run.commands.flatMap((command) => withInline(command, state, depth))
  const output = commandOutput(words, state, run.commands)
  return { ...run, commands, output }
}

const withInline = (command: Execution, state: ShellState, depth: number): ReadonlyArray<Execution> => {
  if (depth >= MAX_CODE_DEPTH) return [command]
  return [command, ...inlineCommands(command, state.place.home, depth + 1)]
}

const callFunction = (name: string, body: ShellNode, args: ReadonlyArray<Word>, caller: ShellState, input: Stream, depth: number): WalkStep => {
  if (caller.calls.includes(name)) return { ...emptyStep(caller), output: emptyStream }
  const positionals = shellPositionals("function", args, caller)
  const frame = { ...caller, place: { ...caller.place, positionals }, bindings: withPositionals(caller.bindings, initialBindings(positionals)), calls: [...caller.calls, name] }
  const run = walkNode(body, frame, input, depth)
  const bindings = withPositionals(run.state.bindings, caller.bindings)
  return { ...run, state: { ...run.state, place: { ...run.state.place, positionals: caller.place.positionals }, bindings, calls: caller.calls } }
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
  if (commands.length === 0) return emptyStream
  const history = producesHistory(words) || words.some((entry) =>
    alternatives(entry, state).some((value) => activeTarget(value, state.loops).includes(historyTarget)))
  return { history, words: literalInput(words) }
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
  if (words.every(({ text }) => assignment.test(text))) return emptyStep(assignments(state, words))
  if (first?.text === "export" && rest.every(({ text }) => assignment.test(text) || /^[A-Za-z_]\w*$/.test(text))) {
    const assigned = assignments(state, rest.values().filter(({ text }) => assignment.test(text)).toArray())
    const exported = rest.map(({ text }) => text.split("=", 1)[0] || "")
    return emptyStep({ ...assigned, place: { ...place, env: new Map([...env, ...Array.from(assigned.vars).filter(([key]) => exported.includes(key))]) } })
  }
  const invocation = executable(words, piped, env)
  const [entry, ...args] = invocation.words
  if (!entry) return idle
  const head = basename(entry.text)
  if (head === "cd" || head === "pushd" || head === "popd") return { ...idle, state: changeDirectory(head, args, state) }
  const at = Option.getOrElse(Option.map(invocation.directory, (directory) => directoryAt(place, expanded(word(directory), place, vars))), () => place)
  const runAt = runnerDirectory(head, args, { ...place, ...at }, vars)
  const code = codeInputs(head, entry.text, args, invocation.env).map((input): CodeInput => {
    if (input.kind === "inline") return input
    return { ...input, source: { ...input.source, text: expanded(input.source, runAt, vars) } }
  })
  const syntaxOnly = syntaxCheck(head, args, code)
  const positionals = codePositionals(code, head, args, state)
  const command = { head, command: invocation.words.map(({ text }) => text).join(" "), cwd: runAt.cwd, unknownCwd: runAt.unknownCwd, env: invocation.env, code, sourceDepth, syntaxOnly, positionals }
  if (head === "git") return { state, commands: gitArgv(args, { ...place, ...at }, state).map((actual) => ({ ...command, args: actual })) }
  if (head !== "find") return { state, commands: [{ ...command, args }] }
  const tasks = findTasks(args).flatMap((task) => executionStep(task, [], { ...state, place: runAt }, sourceDepth).commands)
  return { state, commands: [{ ...command, args }, ...tasks] }
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

const assignments = (state: ShellState, words: ReadonlyArray<Word>): ShellState => ({
  ...state,
  vars: bindingList(words, state.vars, state.place),
  bindings: words.reduce((bindings, entry) => bind(entry, { ...state, bindings }), state.bindings),
})

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
  const options = launcherOptions.get(head) || runtimeOptions.get(head)
  if (!options) return place
  let directory = place
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
      const target = expanded(move.directory.value, place, vars)
      directory = { ...place, ...runnerDestination(head, move.kind, directory, place, target) }
    }
  }
  return directory
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

const inlineCommands = (command: Execution, home: string, depth: number): ReadonlyArray<Execution> =>
  command.code.flatMap((unit) => {
    if (unit.kind !== "inline" || unit.language !== "shell") return []
    return executionPlan(unit.code, { cwd: command.cwd, unknownCwd: command.unknownCwd, home, env: command.env, positionals: command.positionals }, depth)
  })

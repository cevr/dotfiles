// The keychain reader's execution plan. Wrapper options locate the next
// executable; runtime options say which code runs before its entry point.
import { Array as Arr, Option } from "effect"
import { basename, dirname, resolve } from "./path.ts"
import { backquoteEnd, COMMAND_STARTS, expandWord, SHELLS, shellInput, shellSegments, simpleCommands, type ShellSegment, substitutionEnd, type Word } from "./shell-line.ts"
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
const alternatives = (entry: Word, place: ExecutionPlace, bindings: Bindings): Alternatives => {
  const text = expandWord(entry, place.home, expansionCwd(place))
  if (entry.singleQuoted) return [text]
  let values: Alternatives = [""]
  let at = 0
  const expansions = new RegExp(shellExpansion, "g")
  for (let match = expansions.exec(text); match; match = expansions.exec(text)) {
    const [use, braces, colon, fallback, bare] = match
    const prefix = text.slice(at, match.index)
    const dynamic = substitutionReading(text, match.index, use)
    const choices = Option.getOrElse(Option.map(dynamic, ({ value }) => [value]), () => {
      const name = braces || bare || ""
      const otherwise = Option.fromUndefinedOr(fallback)
      return (bindings.get(name) || defaultValues(name, otherwise)).map((choice) => defaultValue(choice, colon || "", otherwise))
    })
    values = values.flatMap((value) => choices.map((choice) => value + prefix + choice))
    at = Option.getOrElse(Option.map(dynamic, ({ end }) => end), () => expansions.lastIndex)
    expansions.lastIndex = at
  }
  return values.map((value) => value + text.slice(at))
}

const substitutionReading = (text: string, at: number, opening: string): Option.Option<{ readonly end: number; readonly value: string }> => {
  if (opening === "$(") return Option.some(substitutionValue(text, at + 2, substitutionEnd(text, at + 2)))
  if (opening === "`") return Option.some(substitutionValue(text, at + 1, backquoteEnd(text, at + 1)))
  return Option.none()
}

const substitutionValue = (text: string, start: number, end: number) => ({
  end, value: producerValue(shellSegments(text.slice(start, end - 1), true).some(({ words }) => producesHistory(words))),
})

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

const defaultValues = (name: string, fallback: Option.Option<string>): Alternatives => {
  if (/^\d+$/.test(name) && Option.isSome(fallback)) return [literalDefault(fallback.value)]
  return [unknownTarget]
}

const defaultValue = (value: string, colon: string, fallback: Option.Option<string>): string => {
  if (colon === ":" && value === "" && Option.isSome(fallback)) return literalDefault(fallback.value)
  return value
}

const literalDefault = (value: string): string => {
  const opening = value.match(/^\$\(|^`/)?.[0] || ""
  const substitution = substitutionReading(value, 0, opening)
  if (Option.isSome(substitution)) return substitution.value.value
  if (/[$`]/.test(value)) return unknownTarget
  return value
}

const bind = (entry: Word, place: ExecutionPlace, bindings: Bindings): Bindings => {
  const split = entry.text.indexOf("=")
  const values = alternatives({ ...entry, bareStart: true, text: entry.text.slice(split + 1) }, place, bindings)
  return new Map([...bindings, [entry.text.slice(0, split), values]])
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
export const executionPlan = (line: string, place: ExecutionPlace, depth = -1): ReadonlyArray<Execution> => {
  const result: Array<Execution> = []
  const env = place.env || new Map<string, string>()
  let state: ShellState = { place: { ...place, env }, vars: env, bindings: initialBindings(place.positionals || []), directories: [], loops: [] }
  const scopes: Array<ShellState> = []
  let piped: ReadonlyArray<Word> = []
  let inPipeline = false
  for (const [index, { words, pipe, boundary }] of withLoopInput(shellSegments(line, true)).entries()) {
    if (boundary === "enter") {
      scopes.push(state)
      inPipeline = false
      continue
    }
    if (boundary === "leave") {
      state = scopes.pop() || state
      inPipeline = false
      piped = []
      continue
    }
    const run = plannedStep(words, piped, state, depth, index)
    if (!pipe && (!inPipeline || isLoop(words[0]) || shellBody(words)[0]?.text === "read")) state = run.state
    inPipeline = pipe
    piped = pipelineInput(pipe, words)
    for (const command of run.commands) {
      result.push(command)
      if (depth < MAX_CODE_DEPTH) result.push(...inlineCommands(command, place.home, depth + 1))
    }
  }
  return result
}

/** A redirection after `done` feeds the matching read condition, not its last body command. */
const withLoopInput = (segments: ReadonlyArray<ShellSegment>): ReadonlyArray<ShellSegment> => {
  const openings: Array<number> = []
  const replacements = new Map<number, ShellSegment>()
  for (const [index, segment] of segments.entries()) {
    const [head, marker, input] = segment.words
    if (!head?.bareStart) continue
    if (head.text === "for" || head.text === "while" || head.text === "until") openings.push(index)
    if (head.text !== "done") continue
    const opening = Option.fromUndefinedOr(openings.pop())
    if (Option.isNone(opening) || marker?.text !== "<<<" || !input) continue
    const start = segments[opening.value]
    if (start && isReadLoop(start.words)) replacements.set(opening.value, { ...start, words: [...start.words, marker, input] })
  }
  return segments.map((segment, index) => replacements.get(index) || segment)
}

const pipelineInput = (pipe: boolean, words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (!pipe) return []
  const literals = literalInput(words)
  if (literals.length > 0) return literals
  if (producesHistory(words)) return [word(historyTarget)]
  return []
}

interface ShellState {
  readonly place: ExecutionPlace
  readonly vars: ReadonlyMap<string, string>
  readonly bindings: Bindings
  readonly loops: ReadonlyArray<number>
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
    return alternatives(entry, state.place, state.bindings)
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
  if (names.length > 1) return names.reduce(({ state: current }, name) => loopBinding(current, name, [unknownTarget]), emptyStep(state))
  const name = names[0] || "REPLY"
  const source = args[redirection + 1]
  if (args[redirection]?.text === "<<<" && source) return loopBinding(state, name, loopWords([source], state).flatMap((value) => value.split(/\r?\n/)))
  if (redirection >= 0) return loopBinding(state, name, [unknownTarget])
  if (piped.length > 0) return loopBinding(state, name, loopWords(piped, state).flatMap((value) => value.split(/\r?\n/)))
  return loopBinding(state, name, [unknownTarget])
}

const readArgumentEnd = (redirection: number, length: number): number => {
  if (redirection < 0) return length
  return redirection
}

const readCondition = (words: ReadonlyArray<Word>): Option.Option<ReadonlyArray<Word>> => {
  if (!words[0]?.bareStart || (words[0].text !== "while" && words[0].text !== "until")) return Option.none()
  const command = words.slice(1).findIndex((entry) => !assignment.test(entry.text)) + 1
  if (words[command]?.text === "read") return Option.some(words.slice(command + 1))
  return Option.none()
}

const isReadLoop = (words: ReadonlyArray<Word>): boolean => Option.isSome(readCondition(words))

const isLoop = (word: Word | void): boolean =>
  word?.bareStart === true && (word.text === "for" || word.text === "while" || word.text === "until")

const shellBody = (words: ReadonlyArray<Word>): ReadonlyArray<Word> =>
  Arr.dropWhile(words, (entry) => entry.bareStart && COMMAND_STARTS.has(entry.text))

const plannedStep = (words: ReadonlyArray<Word>, piped: ReadonlyArray<Word>, state: ShellState, depth: number, index: number): ExecutionStep => {
  const [first, second, third, ...rest] = words
  if (isLoop(first)) {
    const loop = { ...state, loops: [index, ...state.loops] }
    if (first?.text === "for" && second && loopName.test(second.text)) {
      if (third?.text === "in") return loopBinding(loop, second.text, loopWords(rest, state))
      return loopBinding(loop, second.text, state.place.positionals || [unknownTarget])
    }
    const read = readCondition(words)
    if (Option.isSome(read)) return loopRead(read.value, piped, loop)
    return loopCondition(words.slice(1), piped, loop, depth)
  }
  if (first?.bareStart && first.text === "done") return emptyStep({ ...state, loops: state.loops.slice(1) })
  if (first?.bareStart && first.text === "fi") return emptyStep(state)
  const body = shellBody(words)
  if (body[0]?.text === "read") return loopRead(body.slice(1), piped, state)
  return executionStep(body, piped, state, depth)
}

const loopCondition = (words: ReadonlyArray<Word>, piped: ReadonlyArray<Word>, state: ShellState, depth: number): ExecutionStep => {
  if (!words.every(({ text }) => assignment.test(text))) return executionStep(words, piped, state, depth)
  return words.reduce(({ state: current }, entry) => {
    const bound = assignments(current, [entry])
    const name = entry.text.slice(0, entry.text.indexOf("="))
    return loopBinding(bound, name, bound.bindings.get(name) || [unknownTarget])
  }, emptyStep(state))
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
  const positionals = shellPositionals(head, args, state)
  const command = { head, command: invocation.words.map(({ text }) => text).join(" "), cwd: runAt.cwd, unknownCwd: runAt.unknownCwd, env: invocation.env, code, sourceDepth, syntaxOnly, positionals }
  if (head === "git") return { state, commands: gitArgv(args, { ...place, ...at }, state).map((actual) => ({ ...command, args: actual })) }
  if (head !== "find") return { state, commands: [{ ...command, args }] }
  const tasks = findTasks(args).flatMap((task) => executionStep(task, [], { ...state, place: runAt }, sourceDepth).commands)
  return { state, commands: [{ ...command, args }, ...tasks] }
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
  bindings: words.reduce((known, entry) => bind(entry, state.place, known), state.bindings),
})

const gitArgv = (args: ReadonlyArray<Word>, place: ExecutionPlace, state: ShellState): ReadonlyArray<ReadonlyArray<Word>> =>
  args.reduce<ReadonlyArray<ReadonlyArray<Word>>>((rows, arg) =>
    rows.flatMap((row) => alternatives(arg, place, state.bindings).map((text) => [...row, { ...arg, text: activeTarget(text, state.loops) }])), [[]])

const shellPositionals = (head: string, args: ReadonlyArray<Word>, state: ShellState): ReadonlyArray<string> => {
  const words = positionalWords(head, args)
  return words.map((arg) => activeTarget(singleValue(alternatives(arg, state.place, state.bindings)), state.loops))
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

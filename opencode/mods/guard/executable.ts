// The keychain reader's execution plan. Wrapper options locate the next
// executable; runtime options say which code runs before its entry point.
import { Array as Arr, Option } from "effect"
import { basename, resolve } from "./path.ts"
import { COMMAND_STARTS, expandWord, SHELLS, shellInput, shellSegments, simpleCommands, type Word } from "./shell-line.ts"

type OptionKind = "flag" | "value" | "preload" | "code" | "module" | "stop" | "replace" | "check"
type Options = ReadonlyMap<string, OptionKind>
const options = (...groups: ReadonlyArray<readonly [OptionKind, string]>): Options =>
  new Map(groups.flatMap(([kind, words]) => words.split(" ").map((name) => [name, kind] as const)))
const envOptions = options(["value", "-u --unset -C --chdir -S --split-string"], ["flag", "-i --ignore-environment -0 --null"], ["stop", "-h --help --version"])

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
    ["value", "--cwd --config --env-file --conditions --filter --loader --define --port"],
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
  if (/^-[^-].+/.test(input.text) && !table.has(input.text) && ["code", "value", "module", "preload", "replace"].includes(table.get(key) || "")) {
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
  if (Option.isNone(next.replacement)) return [...next.words, ...input]
  const pattern = next.replacement.value
  if (pattern === "") return next.words
  const value = input.map((entry) => entry.text).join(" ") || "$XARGS_INPUT"
  return next.words.map((entry) => ({ ...entry, text: entry.text.replaceAll(pattern, value) }))
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
}

export interface Execution {
  readonly head: string
  readonly args: ReadonlyArray<Word>
  readonly command: string
  readonly cwd: string
  readonly env: ReadonlyMap<string, string>
  readonly code: ReadonlyArray<CodeInput>
  readonly inlineShell?: true
}

export const MAX_CODE_DEPTH = 6
const variable = /\$(?:\{([A-Za-z_][A-Za-z_0-9]*)\}|([A-Za-z_][A-Za-z_0-9]*))/g

const expanded = (entry: Word, place: ExecutionPlace, vars: ReadonlyMap<string, string>): string => {
  const text = expandWord(entry, place.home, place.cwd)
  if (entry.singleQuoted) return text
  return text.replace(variable, (use, braces: string, bare: string) => vars.get(braces || bare) || use)
}

const bindingList = (words: ReadonlyArray<Word>, vars: ReadonlyMap<string, string>, place: ExecutionPlace) =>
  words.reduce((known, entry) => assigned({ ...entry, text: expanded(entry, place, known) }, known), vars)

/** Commands and their ordered source inputs, including inline shell commands in their actual execution position. */
export const executionPlan = (line: string, place: ExecutionPlace, depth = 0): ReadonlyArray<Execution> => {
  const result: Array<Execution> = []
  let cwd = place.cwd
  let env = place.env || new Map<string, string>()
  let vars = env
  let piped: ReadonlyArray<Word> = []
  for (const { words, pipe } of shellSegments(line)) {
    const frame: ExecutionPlace = { cwd, home: place.home, env }
    const run = executionStep(words, piped, frame, vars)
    piped = []
    if (pipe) piped = literalInput(words)
    cwd = run.cwd
    env = run.env
    vars = run.vars
    for (const command of run.commands) {
      result.push(command)
      if (depth < MAX_CODE_DEPTH) result.push(...inlineCommands(command, place.home, depth + 1))
    }
  }
  return result
}

interface ExecutionStep {
  readonly cwd: string
  readonly env: ReadonlyMap<string, string>
  readonly vars: ReadonlyMap<string, string>
  readonly commands: ReadonlyArray<Execution>
}

const executionStep = (words: ReadonlyArray<Word>, piped: ReadonlyArray<Word>, place: ExecutionPlace, vars: ReadonlyMap<string, string>): ExecutionStep => {
  const env = place.env || new Map<string, string>()
  const state: ExecutionStep = { cwd: place.cwd, env, vars, commands: [] }
  const [first, ...rest] = words
  if (words.every(({ text }) => assignment.test(text))) return { ...state, vars: bindingList(words, vars, place) }
  if (first?.text === "export" && rest.every(({ text }) => assignment.test(text) || /^[A-Za-z_]\w*$/.test(text))) {
    const bound = bindingList(rest.filter(({ text }) => assignment.test(text)), vars, place)
    const exported = rest.map(({ text }) => text.split("=", 1)[0] || "")
    return { ...state, vars: bound, env: new Map([...env, ...Array.from(bound).filter(([key]) => exported.includes(key))]) }
  }
  const invocation = executable(words, piped, env)
  const [entry, ...args] = invocation.words
  if (!entry) return state
  const head = basename(entry.text)
  if (head === "cd") return { ...state, cwd: resolve(place.cwd, expanded(args[0] || word(place.home), place, vars)) }
  const cwd = Option.getOrElse(Option.map(invocation.directory, (directory) => resolve(place.cwd, directory)), () => place.cwd)
  const code = codeInputs(head, entry.text, args, invocation.env).map((input): CodeInput => {
    if (input.kind === "inline") return input
    return { ...input, source: { ...input.source, text: expanded(input.source, { ...place, cwd }, vars) } }
  })
  return { ...state, commands: [{ head, args, command: invocation.words.map(({ text }) => text).join(" "), cwd, env: invocation.env, code }] }
}

const inlineCommands = (command: Execution, home: string, depth: number): ReadonlyArray<Execution> =>
  command.code.flatMap((unit) => {
    if (unit.kind !== "inline" || unit.language !== "shell") return []
    return executionPlan(unit.code, { cwd: command.cwd, home, env: command.env }, depth).map((entry): Execution => ({ ...entry, inlineShell: true }))
  })

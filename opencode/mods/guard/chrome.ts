// The guard's keychain rule: a Chrome started for a DevTools port or headless
// passes `--use-mock-keychain` and `--password-store=basic`. Without them a
// Chrome reads its "Safe Storage" key from the login keychain at startup;
// Chrome for Testing is not on that item's access list, so macOS puts a
// keychain dialog on the owner's screen for each launch (2026-11-22: seven
// dialogs in twelve minutes, each from a bisect running an old manna commit
// whose launcher predated its keychain fix; the owner: "Can we put the mock
// keychain so I don't keep getting this pop-up?").
//
// It refuses only where it can name a way through that works:
// - A command line that runs a Chrome binary (a Chrome, Chromium, Chrome for
//   Testing or headless-shell program, a `$CHROME`-like variable, or
//   `open -a "Google Chrome" --args …`) with `--remote-debugging-*` or
//   `--headless*` and without both flags: use Playwright or the browse tool.
//   The owner's own Chrome start opens no DevTools port, so it never matches.
// - A script a line actually runs (`bun x.ts`, `node x.mjs`, `sh x.sh`,
//   `./vendor/launcher.sh`, `bun -e '…'`; not `sh -n x.sh`) that hands
//   such a list to a Chrome it names itself: a spawn-like call whose program is
//   a Chrome path literal (or a name bound to one in the file), or a
//   Puppeteer/Playwright `launch` with `ignoreDefaultArgs: true`. A list a
//   script only reads (`args.includes('--headless')`), a help text, or a launch
//   of a browser the script asks another module for is not one: those are its
//   launcher's, held by that launcher (Exact's `chromium()` honours CHROME).
// - `git bisect run`, a launcher after a checkout or bisect start, or a script
//   that selects detached revisions (including a driver named *bisect*):
//   an old revision's browser launcher may predate the flags, and only the
//   CHROME shim reaches it. Git subcommands must be in executable positions.
//   Reads of Git or shell words as arguments, file names, or text aren't runs.
// The hook follows statically named child code with the same plan and a bounded loader.
// Stated limit: a literal old ref can be missed when carried through `${R%…}`,
// `${X:-$Y}`, `local`, `declare`, `printf -v`, or `$(printf …)` / a pipe into `read`
// before checkout. This is not a general shell interpreter.
import { Array as Arr, Effect, Option, Schema } from "effect"
import { type CodeInput, distinctEntries, type Execution, executionPaths, executionPlan, inlineShellPaths, type Language, literalPath, MAX_CODE_DEPTH, MAX_PATH_STATES, type PathPlan, READERS, word } from "./executable.ts"
import { basename, dirname, resolve, within } from "./path.ts"
import { renderRefusal } from "./message.ts"
import { gitAction, type GitAction } from "./revision.ts"
import { type Word } from "./shell-line.ts"
import { type Place } from "./verdict.ts"

/** The two flags that keep a Chrome off the login keychain: the mock keychain (macOS) and the plain password store (Linux). */
export const KEYCHAIN_FLAGS: ReadonlyArray<string> = ["--use-mock-keychain", "--password-store=basic"]

/** The shim a launcher that reads CHROME starts Chrome through, with both flags added. */
export const SHIM = "$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"

/** A Chrome program's name, its folder dropped: Google Chrome (for Testing, Canary…), Chromium, the headless shell, Brave, Edge. */
const CHROME_PROGRAM =
  /^(?:google[- ]chrome(?:[- ](?:stable|beta|dev|unstable|canary|for testing))?|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|brave(?:[- ]browser)?|microsoft edge|msedge)(?:\.app|\.exe)?$/i

/** A variable that names a Chrome binary, as a launch writes it: `$CHROME`, `${CHROMIUM_BIN}`. */
const CHROME_VARIABLE = /^\$\{?([A-Za-z_]*CHROM[A-Za-z_]*)\}?$/i

/** A flag that opens Chrome's DevTools protocol or runs it headless. */
const opens = (flag: string): boolean => flag.startsWith("--remote-debugging-") || flag.startsWith("--headless")

/** Whether a path's last part names a Chrome program. */
const isChromePath = (path: string): boolean => CHROME_PROGRAM.test(path.slice(path.lastIndexOf("/") + 1))

const usesShim = (env: ReadonlyMap<string, string>): boolean => basename(env.get("CHROME") || "") === basename(SHIM)

/** What a refused launch needs: both flags on its list, or the shim before a bisect over old commits. */
export type Remedy = "flags" | "shim" | "unknown"

/** One launch the rule refuses: the command as the refusal names it, the script that starts Chrome when a script does, and its way through. */
export interface BareLaunch {
  readonly command: string
  readonly script: Option.Option<string>
  readonly remedy: Remedy
  readonly oldCheckout?: true
  readonly rebaseExec?: true
  readonly opaqueContinuation?: true
  readonly pathLimit?: true
}

/** Whether a launch's flags open DevTools or headless without both keychain flags. */
const bare = (flags: ReadonlyArray<string>): boolean => flags.some(opens) && !KEYCHAIN_FLAGS.every((flag) => flags.includes(flag))

/** Whether a word names a Chrome program or a variable holding one; `$CHROME` only while the line does not set it to the shim. */
const namesChrome = (word: Word, shim: boolean): boolean => {
  if (isChromePath(word.text)) return true
  return Option.match(Option.fromNullishOr(CHROME_VARIABLE.exec(word.text)), {
    onNone: () => false,
    onSome: (variable) => !(shim && variable[1] === "CHROME"),
  })
}

/** The flags a command passes a Chrome it names: every word after the first that names one; none when it names none. */
const chromeFlags = (head: string, words: ReadonlyArray<Word>, shim: boolean): Option.Option<ReadonlyArray<string>> => {
  if (READERS.has(head)) return Option.none()
  return Option.map(
    Arr.findFirstIndex(words, (word) => namesChrome(word, shim)),
    (at) => words.slice(at + 1).map((word) => word.text),
  )
}

/** Inline code a runtime is given. */
export const Inline = Schema.TaggedStruct("Inline", { code: Schema.String })
/** A script file a runtime runs, its path absolute. */
export const ScriptFile = Schema.TaggedStruct("ScriptFile", { path: Schema.String })
/** What a runtime command runs. */
export const Ran = Schema.Union([Inline, ScriptFile])
export type Ran = typeof Ran.Type

type TreeLookup = ReadonlyMap<string, Option.Option<string>>
interface ChangedTree {
  readonly tree: Option.Option<string>
  readonly exact: boolean
  readonly uncertain: boolean
}

interface CommandEvent {
  readonly kind: "command"
  readonly execution: Execution
  readonly source: Option.Option<SourceContext>
  readonly launcher: boolean
  readonly files: ReadonlyArray<string>
}
interface FindingEvent {
  readonly kind: "finding"
  readonly launch: BareLaunch
}
type ExecutionEvent = CommandEvent | FindingEvent

interface SourceContext {
  readonly invocation: string
  readonly name: string
  readonly language: Language
}

/** Shell has a command plan. Other languages supply positive literal evidence, not a full plan. */
const walkable = (language: Language): boolean => language === "shell"

const commandEvent = (execution: Execution, source: Option.Option<SourceContext>, expandedShell = false): CommandEvent =>
  ({
    kind: "command", execution, source,
    launcher: !READERS.has(execution.head) && !execution.syntaxOnly && !expandedShell &&
      !execution.code.some((input) => input.kind === "inline" && walkable(input.language)),
    files: launcherFiles(execution),
  })

const launcherFiles = (execution: Execution): ReadonlyArray<string> => {
  if (READERS.has(execution.head) || execution.syntaxOnly) return []
  return execution.code.flatMap((input) => fileDirectory(input, execution))
}

const fileDirectory = (input: CodeInput, execution: Execution): ReadonlyArray<string> => {
  if (input.kind !== "file" || !literalPath(input.source.text)) return []
  if (execution.unknownCwd && !input.source.text.startsWith("/")) return []
  return [dirname(resolve(execution.cwd, input.source.text))]
}

/** One ordered tree-effect state per reaching trace. Readable child events are already at their call site. */
const decideTimeline = (line: string, events: ReadonlyArray<ExecutionEvent>, roots: TreeLookup): ReadonlyArray<BareLaunch> => {
  const changes = new Map<string, ChangedTree>()
  const refsOnly = new Set<string>()
  const direct: Array<BareLaunch> = []
  let relation = Option.none<BareLaunch>()
  let continuation = Option.none<BareLaunch>()
  for (const event of events) {
    if (event.kind === "finding") {
      direct.push(event.launch)
      continue
    }
    const command = event.execution
    direct.push(...directLaunch(command).map((launch) => attributeLaunch(launch, event.source)))
    const action = actionAt(command, (tree) => refsOnly.has(treeName(tree, roots)))
    if (!Option.exists(relation, definite)) relation = prefer(relation, eventHazard(line, event, action, Array.from(changes.values()), roots))
    if (Option.isNone(continuation)) continuation = opaqueContinuation(event, action)
    rememberAction(action, roots, changes, refsOnly)
  }
  if (direct.length > 0) return direct
  return Option.toArray(prefer(relation, continuation))
}

const definite = (launch: BareLaunch): boolean => launch.remedy !== "unknown"
const prefer = (earlier: Option.Option<BareLaunch>, later: Option.Option<BareLaunch>): Option.Option<BareLaunch> => {
  if (Option.isNone(earlier) || (!Option.exists(earlier, definite) && Option.exists(later, definite))) return later
  return earlier
}

const decidePaths = (line: string, plan: PathPlan<ExecutionEvent>, roots: TreeLookup): ReadonlyArray<BareLaunch> => {
  const findings = [...plan.paths, ...plan.witnesses].flatMap((path) => decideTimeline(line, path, roots))
  const clear: Array<BareLaunch> = []
  for (const launch of findings) {
    if (definite(launch) && !clear.some((known) => sameLaunch(known, launch))) clear.push(launch)
  }
  if (clear.length > 0) return clear
  if (plan.limited) return [{ command: line, script: Option.none(), remedy: "unknown", pathLimit: true }]
  return findings.slice(0, 1)
}

const sameLaunch = (left: BareLaunch, right: BareLaunch): boolean =>
  left.command === right.command && left.remedy === right.remedy &&
  Option.getOrElse(left.script, () => "") === Option.getOrElse(right.script, () => "") &&
  left.oldCheckout === right.oldCheckout && left.rebaseExec === right.rebaseExec

const opaqueContinuation = ({ execution, source }: CommandEvent, action: GitAction): Option.Option<BareLaunch> => {
  if (action.revision !== "moves" || usesShim(execution.env)) return Option.none()
  return source.pipe(
    Option.filter(({ language }) => !walkable(language)),
    Option.map(({ invocation, name }): BareLaunch => ({ command: invocation, script: Option.some(name), remedy: "unknown", opaqueContinuation: true })),
  )
}

const eventHazard = (line: string, event: CommandEvent, action: GitAction, changes: ReadonlyArray<ChangedTree>, roots: TreeLookup): Option.Option<BareLaunch> => {
  const { execution, source } = event
  if (usesShim(execution.env)) return Option.none()
  if (action.rebaseExec === true) return Option.some(attributeLaunch({ command: execution.command, script: Option.none(), remedy: "shim", rebaseExec: true }, source))
  if (changes.length === 0) return Option.none()
  const directories = launcherLocations(event, changes, roots)
  let hazard = Option.none<BareLaunch>()
  for (const directory of directories) {
    for (const change of changes) {
      if (!coincides(change, directory, roots)) continue
      const remedy = changedRemedy(change, directory)
      hazard = Option.some({ command: line, script: Option.map(source, ({ name }) => name), remedy, oldCheckout: true })
      if (remedy !== "unknown") return hazard
    }
  }
  return hazard
}

interface Location {
  readonly cwd: string
  readonly unknownCwd?: true
}

/** File ownership overrides the runner cwd only when a checkout boundary supplies evidence. */
const launcherLocations = ({ execution, launcher, files }: CommandEvent, changes: ReadonlyArray<ChangedTree>, roots: TreeLookup): ReadonlyArray<Location> => {
  const located = files.flatMap((cwd) => fileLocation(cwd, execution, launcher, changes, roots))
  if (located.length > 0) return located
  if (launcher && !files.some((cwd) => Option.isSome(checkoutAt(cwd, roots)))) return [execution]
  return []
}

const fileLocation = (cwd: string, execution: Location, launcher: boolean, changes: ReadonlyArray<ChangedTree>, roots: TreeLookup): ReadonlyArray<Location> => {
  const file = { cwd }
  const known = checkoutAt(cwd, roots)
  if (Option.isSome(known)) {
    if (launcher || !within(execution.cwd, known.value) || Option.exists(checkoutAt(execution.cwd, roots), (root) => root !== known.value)) return [file]
    return []
  }
  const observed = changes.some(({ tree }) => Option.exists(tree, (root) => within(cwd, root) && (launcher || !within(execution.cwd, root))))
  if (observed) return [file]
  return []
}

const attributeLaunch = (launch: BareLaunch, source: Option.Option<SourceContext>): BareLaunch =>
  Option.getOrElse(Option.map(source, ({ invocation, name }) => ({ ...launch, command: invocation, script: Option.some(name) })), () => launch)

const actionAt = (command: Execution, refsOnly?: (tree: Option.Option<string>) => boolean): GitAction =>
  gitAction(command.head, command.args.map((entry) => entry.text), command, refsOnly)

const checkoutAt = (cwd: string, roots: TreeLookup): Option.Option<string> => roots.get(cwd) || Option.none()
const treeName = (tree: Option.Option<string>, roots: TreeLookup): string =>
  Option.getOrElse(Option.map(tree, (path) => Option.getOrElse(checkoutAt(path, roots), () => path)), () => "")

const rememberAction = (action: GitAction, roots: TreeLookup, changes: Map<string, ChangedTree>, refsOnly: Set<string>) => {
  const tree = treeName(action.tree, roots)
  if (tree !== "" && action.bisectMode === "refs") refsOnly.add(tree)
  else if (tree !== "" && action.bisectMode) refsOnly.delete(tree)
  // Its exec runs during rebase; it doesn't make later commands run at an intermediate commit.
  if (action.rebaseExec) return
  if (action.revision !== "moves" && action.revision !== "unknown") return
  const exact = action.newTree === true || action.explicitTree === true
  const target = action.tree.pipe(Option.map((path) => changedRoot(path, exact, roots)))
  const name = Option.getOrElse(target, () => "")
  const previous = changes.get(name)
  const uncertain = action.revision === "unknown" && (previous?.uncertain ?? true)
  changes.set(name, { tree: target, exact: exact || previous?.exact === true, uncertain })
}

const changedRoot = (path: string, exact: boolean, roots: TreeLookup): string => {
  if (exact) return path
  return Option.getOrElse(checkoutAt(path, roots), () => path)
}

const coincides = (change: ChangedTree, command: Location, roots: TreeLookup): boolean => {
  if (command.unknownCwd || Option.isNone(change.tree)) return true
  const tree = change.tree.value
  const launcher = checkoutAt(command.cwd, roots)
  if (change.exact) return within(command.cwd, tree) && !Option.exists(launcher, (root) => root !== tree && within(root, tree))
  if (Option.isSome(launcher)) return launcher.value === tree
  return within(command.cwd, tree)
}

const changedRemedy = (change: ChangedTree, command: Location): Remedy => {
  if (change.uncertain || Option.isNone(change.tree) || command.unknownCwd) return "unknown"
  return "shim"
}

/** What a runtime of a line runs, with the command as the refusal names it, and whether the line sets CHROME to the shim. */
export interface RuntimeRun {
  readonly command: string
  readonly ran: Ran
  readonly shimmed: boolean
  readonly shell?: boolean
  readonly language?: Language
  readonly place?: Place
  readonly env?: ReadonlyMap<string, string>
  readonly unknownCwd?: true
  readonly positionals?: ReadonlyArray<string>
}

/** Each script a line executes (as a file or inline), in order. Tests and syntax checks do not supply script entry points. */
export const runtimeRuns = (line: string, place: Place): ReadonlyArray<RuntimeRun> =>
  plannedRuns(executionPlan(line, place), place.home)

const unitPlan = <A>(...entries: ReadonlyArray<A>): PathPlan<A> => ({ paths: [entries], witnesses: [], limited: false })

const sequencePlans = <A>(left: PathPlan<A>, right: PathPlan<A>): PathPlan<A> => {
  if (left.limited) return left
  const paths: Array<ReadonlyArray<A>> = []
  const witnesses = [...left.witnesses, ...left.paths.flatMap((prefix) => right.witnesses.map((suffix) => [...prefix, ...suffix]))]
  for (const prefix of left.paths) for (const suffix of right.paths) {
    if (paths.length === MAX_PATH_STATES) return { paths, witnesses, limited: true }
    paths.push([...prefix, ...suffix])
  }
  return { paths, witnesses, limited: right.limited }
}

const expandPlan = <A>(plan: PathPlan<Execution>, expansions: ReadonlyMap<Execution, PathPlan<A>>): PathPlan<A> => {
  const paths: Array<ReadonlyArray<A>> = []
  const witnesses: Array<ReadonlyArray<A>> = []
  let limited = plan.limited
  // A shell may have more completed traces than live paths. Child alternatives
  // can multiply those traces, but must not grow the analysis without bound.
  const budget = Math.max(MAX_PATH_STATES, plan.paths.length)
  for (const trace of plan.paths) {
    const branch = expandTrace(trace, expansions)
    witnesses.push(...branch.witnesses)
    for (const path of branch.paths) {
      if (paths.length === budget) return { paths, witnesses, limited: true }
      paths.push(path)
    }
    limited ||= branch.limited
  }
  for (const trace of plan.witnesses) {
    const branch = expandTrace(trace, expansions)
    witnesses.push(...branch.witnesses, ...branch.paths)
    limited ||= branch.limited
  }
  return { paths, witnesses, limited }
}

const expandTrace = <A>(trace: ReadonlyArray<Execution>, expansions: ReadonlyMap<Execution, PathPlan<A>>): PathPlan<A> =>
  trace.reduce((prefix, command) => sequencePlans(prefix, expansions.get(command) || unitPlan<A>()), unitPlan<A>())

const inlinePlan = (plan: PathPlan<Execution>, home: string): PathPlan<Execution> => {
  const entries = new Map(distinctEntries(plan).map((command) => {
    let expanded = unitPlan(command)
    for (const input of command.code) {
      if (input.kind !== "inline" || input.language !== "shell") continue
      expanded = sequencePlans(expanded, inlinePlan(inlineShellPaths(command, home, input.code), home))
    }
    return [command, expanded]
  }))
  return expandPlan(plan, entries)
}

const mapPlan = <A, B>(plan: PathPlan<A>, f: (value: A) => B): PathPlan<B> =>
  ({ ...plan, paths: plan.paths.map((trace) => trace.map(f)), witnesses: plan.witnesses.map((trace) => trace.map(f)) })

const plannedRuns = (commands: ReadonlyArray<Execution>, home: string): ReadonlyArray<RuntimeRun> => commands.flatMap((command) =>
  command.code.flatMap((input) => {
    if (READERS.has(command.head)) return []
    // Inline shell commands are already expanded into the plan.
    if (input.kind === "inline" && input.language === "shell") return []
    if (input.kind === "file" && command.unknownCwd && !input.source.text.startsWith("/")) return []
    return [{
      command: command.command, ran: resolveEntry(input, command.cwd), shimmed: usesShim(command.env),
      language: input.language, place: { cwd: command.cwd, home }, env: command.env, unknownCwd: command.unknownCwd, positionals: command.positionals,
    }]
  }),
)

const resolveEntry = (input: CodeInput, cwd: string): Ran => {
  if (input.kind === "inline") return Inline.make({ code: input.code })
  return ScriptFile.make({ path: resolve(cwd, input.source.text) })
}

/** Each command of `line` that starts Chrome for DevTools or headless without both keychain flags, or runs a bisect without the shim. */
export const bareLaunches = (line: string, place: Place): ReadonlyArray<BareLaunch> => {
  const events = mapPlan(inlinePlan(executionPaths(line, place), place.home), (entry) => commandEvent(entry, Option.none()))
  return decidePaths(line, events, new Map())
}

const directLaunch = ({ head, args, command, env }: Execution): ReadonlyArray<BareLaunch> => {
  const shim = usesShim(env)
  if (!shim && gitAction(head, args.map((entry) => entry.text)).bisectRun) return [{ command, script: Option.none(), remedy: "shim" }]
  if (head !== "open" && !namesChrome(word(head), shim)) return []
  return Option.toArray(Option.filter(chromeFlags(head, [word(head), ...args], shim), bare)).map((): BareLaunch => ({ command, script: Option.none(), remedy: "flags" }))
}

// ── A script's text ──

/** The brackets a script's text nests: each opener at the index of its closer. */
const OPENERS = "[{("
const CLOSERS = "]})"

/** The end of the line comment at `at` (`// …`), or `at` itself when none starts there. */
const pastComment = (text: string, at: number): number => {
  if (!text.startsWith("//", at)) return at
  const end = text.indexOf("\n", at)
  return Math.max(end, text.length * Number(end < 0)) - 1
}

/** The index of the bracket that closes the one at `open`, past quoted text and line comments; the text's end when none does. */
const closing = (text: string, open: number): number => {
  const stack: Array<string> = []
  let quote = ""
  for (let at = open; at < text.length; at += 1) {
    const ch = text.charAt(at)
    if (quote !== "") {
      if (ch === "\\") at += 1
      else if (ch === quote || ch === "\n") quote = ""
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if (text.startsWith("//", at)) at = pastComment(text, at)
    else if (OPENERS.includes(ch)) stack.push(CLOSERS.charAt(OPENERS.indexOf(ch)))
    else if (ch === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return at
    }
  }
  return text.length
}

/** The text inside the brackets that open at `open`. */
const inside = (text: string, open: number): string => text.slice(open + 1, closing(text, open))

/** `text` split at its top-level commas, past brackets and quotes. */
const topLevel = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let from = 0
  let quote = ""
  for (let at = 0; at < text.length; at += 1) {
    const ch = text.charAt(at)
    if (quote !== "") {
      if (ch === "\\") at += 1
      else if (ch === quote || ch === "\n") quote = ""
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if (text.startsWith("//", at)) at = pastComment(text, at)
    else if (OPENERS.includes(ch)) at = closing(text, at)
    else if (ch === ",") {
      parts.push(text.slice(from, at))
      from = at + 1
    }
  }
  return [...parts, text.slice(from)]
}

/** A string literal's content (a template's `${…}` kept as written). */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*?)\1/g

/** The contents of the string literals in `text`. */
const literalsIn = (text: string): ReadonlyArray<string> => Array.from(text.matchAll(LITERAL), (match) => `${match[2]}`)

/** A name a script binds at its top: `const NAME =`, `let NAME =`, `var NAME =` (a type annotation allowed). */
const BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g

/** Each name a script binds, with the index its value starts at. */
const bindingsOf = (text: string): ReadonlyArray<readonly [string, number]> => Array.from(text.matchAll(BINDING), (match) => [`${match[1]}`, match.index + match[0].length] as const)

/** The names a script binds to an array literal, each with the text inside it. */
const arraysOf = (text: string): ReadonlyMap<string, string> =>
  new Map(bindingsOf(text).flatMap(([name, at]) => Arr.filter([[name, inside(text, at)] as const], () => text.charAt(at) === "[")))

/** The names a script binds to an expression naming a Chrome program (`const CHROME = join(HOME, '…/chrome-headless-shell')`). */
const chromeNamesOf = (text: string): ReadonlySet<string> =>
  new Set(bindingsOf(text).flatMap(([name, at]) => Arr.filter([name], () => literalsIn(`${text.slice(at).split("\n", 1)[0]}`).some(isChromePath))))

/** What a script's launch reads of its text: the arrays it binds and the names it binds to a Chrome. */
interface Script {
  readonly arrays: ReadonlyMap<string, string>
  readonly chromes: ReadonlySet<string>
}

/** Whether an expression is a Chrome program: a path literal naming one, or a name the script binds to one. */
const isChromeExpression = (expression: string, script: Script): boolean => {
  const trimmed = expression.trim()
  if (script.chromes.has(trimmed)) return true
  return Option.match(Arr.head(literalsIn(trimmed)), { onNone: () => false, onSome: (literal) => literal === trimmed.slice(1, -1) && isChromePath(literal) })
}

/** The flags a list holds: its literals, and those of an array the script binds that it spreads or names. */
const flagsOf = (list: string, script: Script): ReadonlyArray<string> => [
  ...literalsIn(list),
  ...Array.from(list.matchAll(/[A-Za-z_$][\w$]*/g), (match) => match[0]).flatMap((name) => literalsIn(Option.getOrElse(Option.fromUndefinedOr(script.arrays.get(name)), () => ""))),
]

/** The list an argument is: an array literal's inside, or the array a name the script binds holds; none for anything else. */
const listOf = (argument: string, script: Script): Option.Option<string> => {
  const trimmed = argument.trim()
  if (trimmed.startsWith("[")) return Option.some(inside(trimmed, 0))
  return Option.fromUndefinedOr(script.arrays.get(trimmed))
}

/** Read launch calls in the source, not their spelling in JS comments or string literals. */
const CALL = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\$\s*`((?:\\.|[^`\\])*)`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync|sh|launch)\s*\(/g
const PY_CALL = /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:subprocess\.(run|Popen|call|check_call|check_output)|os\.(system))\s*\(/g
const callsIn = (text: string) => Array.from(text.matchAll(CALL)).flatMap((match) =>
  Option.toArray(Option.map(Option.fromUndefinedOr(match[2]), (name) => ({ name, open: match.index + match[0].length - 1 }))),
)

/** The program and the arguments' list a spawn-like call at `open` hands it, in any of its forms. */
const spawned = (text: string, open: number, script: Script): Option.Option<{ readonly program: string; readonly list: string }> => {
  const args = topLevel(inside(text, open))
  const first = Option.getOrElse(Arr.head(args), () => "").trim()
  // spawn([program, ...flags]) and Bun.spawn({ cmd: [program, ...flags] })
  const command = Option.orElse(Option.liftPredicate(first, (each) => each.startsWith("[")), () =>
    Option.map(Option.fromNullishOr(/\bcmd\s*:\s*\[/.exec(first)), (match) => first.slice(match.index + match[0].length - 1)),
  )
  if (Option.isSome(command)) {
    const parts = topLevel(inside(command.value, 0))
    return Option.some({ program: Option.getOrElse(Arr.head(parts), () => ""), list: parts.slice(1).join(",") })
  }
  // spawn(program, [...flags])
  return Option.map(listOf(Option.getOrElse(Arr.get(args, 1), () => ""), script), (list) => ({ program: first, list }))
}

/** Whether a spawn-like call in the script hands a Chrome it names a DevTools or headless list without both keychain flags. */
const spawnsBare = (text: string, script: Script): boolean =>
  callsIn(text).some(({ name, open }) =>
    name !== "launch" && Option.exists(spawned(text, open, script), ({ program, list }) => isChromeExpression(program, script) && bare(flagsOf(list, script))),
  )

/** Whether a Puppeteer/Playwright launch drops its default flags (`ignoreDefaultArgs: true`) and passes no keychain flags itself. */
const launchesBare = (text: string, script: Script): boolean =>
  callsIn(text).some(({ name, open }) => {
    if (name !== "launch") return false
    const options = inside(text, open).trim()
    if (!options.startsWith("{")) return false
    if (!/\bignoreDefaultArgs\s*:\s*true\b/.test(options)) return false
    const named = Option.fromNullishOr(/\bargs\s*(?::\s*([^,}\n]+))?/.exec(options))
    const list = Option.flatMap(named, (match) => listOf(Option.getOrElse(Option.fromUndefinedOr(match[1]), () => "args"), script))
    const flags = flagsOf(Option.getOrElse(list, () => ""), script)
    return !KEYCHAIN_FLAGS.every((flag) => flags.includes(flag))
  })

/** Whether a script's text starts a Chrome it names for DevTools or headless without both keychain flags. */
export const scriptLaunchesBare = (text: string): boolean => {
  const script: Script = { arrays: arraysOf(text), chromes: chromeNamesOf(text) }
  return spawnsBare(text, script) || launchesBare(text, script)
}

/** A standalone string operand of a JS process invocation, not an expression merely containing a string. */
const literalWord = (expression: string): string => {
  const trimmed = expression.trim()
  return Option.getOrElse(Option.filter(Arr.head(literalsIn(trimmed)), (literal) => literal === trimmed.slice(1, -1)), () => "")
}

/** Keep the existing convention for an executed bisect driver even when it delegates its Git calls. */
const namedBisect = (ran: Ran): boolean => ran._tag === "ScriptFile" && /bisect/i.test(basename(ran.path))

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
const processArgument = (expression: string): string => literalWord(expression) || "$__GUARD_DYNAMIC"
const literalLine = (call: { readonly program: string; readonly list: string }): string => {
  const program = literalWord(call.program)
  if (program === "" || /\$\{/.test(program)) return ""
  return [program, ...topLevel(call.list).map(processArgument)].map(quote).join(" ")
}

const codeInCall = (text: string, name: string, open: number, script: Script): string => {
  if (name === "launch") return ""
  if (name === "exec" || name === "execSync" || name === "sh" || name === "system") {
    const code = Option.getOrElse(Option.map(Arr.head(topLevel(inside(text, open))), literalWord), () => "")
    if (code !== "") return code
  }
  return Option.getOrElse(Option.map(spawned(text, open, script), literalLine), () => "")
}

const pythonCall = (text: string, name: string, open: number, script: Script): string => {
  const args = topLevel(inside(text, open))
  if (args.some((arg) => /^\s*shell\s*=\s*True\s*$/.test(arg))) return Option.getOrElse(Option.map(Arr.head(args), literalWord), () => "")
  return codeInCall(text, name, open, script)
}

/** Process invocations in a source file feed the same shell plan as the outer call. */
const sourceCalls = (text: string, language: Language): ReadonlyArray<string> => {
  if (language === "auto") return []
  const script: Script = { arrays: arraysOf(text), chromes: new Set() }
  const calls = callsOf(language)
  return Array.from(text.matchAll(calls)).flatMap((match) => {
    const name = match[2] || match[1]
    if (!name) return []
    if (language === "js" && match[1]) return [name]
    const open = match.index + match[0].length - 1
    if (language === "python") return [pythonCall(text, name, open, script)]
    return [codeInCall(text, name, open, script)]
  })
}
const callsOf = (language: Language): RegExp => {
  if (language === "python") return PY_CALL
  return CALL
}

/** How the refusal names what a runtime ran. */
const scriptName = (ran: Ran): string => {
  if (ran._tag === "Inline") return "its inline script"
  return ran.path
}

/** The launch a runtime run makes when its code starts a bare Chrome, or runs old commits without the shim; none when it does neither. */
const scriptLanguage = (run: RuntimeRun, text: string): Language => {
  if (run.language && run.language !== "auto") return run.language
  if (run.shell === true || /\.(?:ba|da|k|z)?sh$/.test(scriptName(run.ran)) || /^#![^\n]*\b(?:sh|bash|zsh|dash|ksh)\b/.test(text)) return "shell"
  if (scriptName(run.ran).endsWith(".py") || /^#![^\n]*\bpython[23]?\b/.test(text)) return "python"
  if (run.language === "auto" && !/^#![^\n]*\b(?:bun|node|deno|tsx)\b/.test(text)) return "auto"
  return "js"
}

const scriptPlace = (run: RuntimeRun): Place => run.place || { cwd: "/", home: "/" }
const scriptEnv = (run: RuntimeRun): ReadonlyMap<string, string> => {
  if (run.env) return run.env
  if (run.shimmed) return new Map([["CHROME", SHIM]])
  return new Map()
}

const sourcePlan = (run: RuntimeRun, text: string, depth: number): PathPlan<Execution> => {
  const language = scriptLanguage(run, text)
  const place = { ...scriptPlace(run), unknownCwd: run.unknownCwd, env: scriptEnv(run) }
  const positionals = shellPositionals(run, language)
  if (walkable(language)) return executionPaths(text, { ...place, positionals }, depth)
  return sourceCalls(text, language).reduce(
    (prefix, line) => sequencePlans(prefix, executionPaths(line, { ...place, positionals }, depth)), unitPlan<Execution>(),
  )
}

const shellPositionals = (run: RuntimeRun, language: Language): ReadonlyArray<string> => {
  if (walkable(language)) return run.positionals || []
  return []
}

const sourceFinding = (run: RuntimeRun, text: string, source: SourceContext): ReadonlyArray<FindingEvent> => {
  const named = (remedy: Remedy): FindingEvent => ({ kind: "finding", launch: { command: source.invocation, script: Option.some(source.name), remedy } })
  if (source.language === "js" && scriptLaunchesBare(text)) return [named("flags")]
  if (source.language !== "auto" && !run.shimmed && namedBisect(run.ran)) return [named("shim")]
  return []
}

const sourceContext = (run: RuntimeRun, text: string, invocation: string): SourceContext =>
  ({ invocation, name: scriptName(run.ran), language: scriptLanguage(run, text) })

/** A local decision does not assume the contents of a child it was not given. */
export const scriptLaunch = (run: RuntimeRun, text: string): Option.Option<BareLaunch> => {
  const source = sourceContext(run, text, run.command)
  const commands = mapPlan(inlinePlan(sourcePlan(run, text, 0), scriptPlace(run).home), (entry) => commandEvent(entry, Option.some(source)))
  return Arr.head(decidePaths(run.command, prependEvents(sourceFinding(run, text, source), commands), new Map()))
}

const prependEvents = (entry: ReadonlyArray<ExecutionEvent>, plan: PathPlan<ExecutionEvent>): PathPlan<ExecutionEvent> =>
  ({ ...plan, paths: plan.paths.map((path) => [...entry, ...path]), witnesses: plan.witnesses.map((path) => [...entry, ...path]) })

export type ScriptLoader = (path: string) => Effect.Effect<Option.Option<string>>
export type TreeRoot = (directory: string) => Effect.Effect<Option.Option<string>>

/** Consult the existing repository boundary only for plans that actually pair Git work with a launcher. */
const rootsFor = Effect.fn("Guard.treeRoots")(function* (events: ReadonlyArray<ExecutionEvent>, root: TreeRoot) {
  const commands = events.flatMap((entry) => {
    if (entry.kind === "command") return [entry.execution]
    return []
  })
  const actions = commands.values().filter(({ head }) => head === "git").map((entry) => actionAt(entry)).toArray()
  if (!actions.some((entry) => entry.revision === "moves" || entry.revision === "unknown")) return new Map<string, Option.Option<string>>()
  const paths = new Set([
    ...actions.flatMap((entry) => Option.toArray(entry.tree)),
    ...events.flatMap(launcherDirectory),
  ])
  const roots = new Map<string, Option.Option<string>>()
  for (const directory of paths) roots.set(directory, yield* root(directory))
  return roots
})

const launcherDirectory = (event: ExecutionEvent): ReadonlyArray<string> => {
  if (event.kind !== "command") return []
  if (!event.execution.unknownCwd && (event.launcher || event.files.length > 0)) return [event.execution.cwd, ...event.files]
  return event.files
}

const lexicalRoot: TreeRoot = () => Effect.succeed(Option.none())

/** Follow an executed source's named children; absent, dynamic, or deeper than six contributes no evidence. */
export const scriptLaunchWith = Effect.fn("Guard.scriptLaunchWith")(function* (run: RuntimeRun, text: string, load: ScriptLoader, depth = 0, root: TreeRoot = lexicalRoot) {
  const events = yield* expandSource(run, text, load, depth, sourceContext(run, text, run.command))
  return Arr.head(decidePaths(run.command, events, yield* rootsFor(distinctEntries(events), root)))
})

/** Expand source events in command order; cwd and environment are scoped to each invoking frame. */
const expandCommands = Effect.fn("Guard.expandCommands")(function* (
  plan: PathPlan<Execution>,
  home: string,
  load: ScriptLoader,
  source: Option.Option<SourceContext>,
): Effect.fn.Return<PathPlan<ExecutionEvent>> {
  const expansions = new Map<Execution, PathPlan<ExecutionEvent>>()
  for (const command of distinctEntries(plan)) {
    expansions.set(command, yield* expandCommand(command, home, load, source))
  }
  return expandPlan(plan, expansions)
})

const expandCommand = Effect.fn("Guard.expandCommand")(function* (command: Execution, home: string, load: ScriptLoader, source: Option.Option<SourceContext>): Effect.fn.Return<PathPlan<ExecutionEvent>> {
  let children = unitPlan<ExecutionEvent>()
  if (command.sourceDepth >= MAX_CODE_DEPTH) return unitPlan(commandEvent(command, source))
  let expandedShell = false
  for (const input of command.code) {
    if (input.kind !== "inline" || input.language !== "shell") continue
    const inline = yield* expandCommands(inlineShellPaths(command, home, input.code), home, load, source)
    children = sequencePlans(children, inline)
  }
  for (const run of plannedRuns([command], home)) {
    const text = yield* readRun(run.ran, load)
    if (Option.isNone(text)) continue
    const invocation = Option.getOrElse(Option.map(source, (frame) => frame.invocation), () => run.command)
    const frame = sourceContext(run, text.value, invocation)
    expandedShell ||= walkable(frame.language)
    children = sequencePlans(children, yield* expandSource(run, text.value, load, command.sourceDepth + 1, frame))
  }
  return prependEvents([commandEvent(command, source, expandedShell)], children)
})

const expandSource = Effect.fn("Guard.expandSource")(function* (run: RuntimeRun, text: string, load: ScriptLoader, depth: number, source: SourceContext): Effect.fn.Return<PathPlan<ExecutionEvent>> {
  const commands = yield* expandCommands(sourcePlan(run, text, depth), scriptPlace(run).home, load, Option.some(source))
  return prependEvents(sourceFinding(run, text, source), commands)
})

const readRun = (ran: Ran, load: ScriptLoader): Effect.Effect<Option.Option<string>> => {
  if (ran._tag === "Inline") return Effect.succeed(Option.some(ran.code))
  if (!literalPath(ran.path)) return Effect.succeed(Option.none())
  return load(ran.path)
}

export const keychainLaunch = Effect.fn("Guard.keychainLaunch")(function* (line: string, place: Place, load: ScriptLoader, root: TreeRoot = lexicalRoot) {
  const events = yield* expandCommands(executionPaths(line, place), place.home, load, Option.none())
  return Arr.head(decidePaths(line, events, yield* rootsFor(distinctEntries(events), root)))
})

/** What a launch does, in the refusal's words. */
const starts = (launch: BareLaunch): string =>
  Option.match(launch.script, { onNone: () => "starts", onSome: (script) => `runs ${script}, which starts` })

/** Why the rule refuses `launch`, and the way through. */
export const keychainReason = (launch: BareLaunch): string => {
  const dialog = "and macOS puts a keychain dialog on the owner's screen at each launch of a Chrome without them"
  if (launch.pathLimit === true)
    return `\`${launch.command}\`: cannot tell what runs after the shell produces more than ${MAX_PATH_STATES} possible path states. Split the compound command so the guard can check each path.`
  if (launch.rebaseExec === true)
    return `\`${launch.command}\` runs a rebase command on intermediate commits, whose browser launchers may predate ${KEYCHAIN_FLAGS.join(" ")}, ${dialog}. Prefix the whole rebase with CHROME="${SHIM}".`
  if (launch.opaqueContinuation === true)
    return `\`${launch.command}\` runs ${Option.getOrElse(launch.script, () => "a program")} that selects a historical Git revision. Cannot tell what the program runs next in the affected working tree. Export CHROME before the whole command: export CHROME="${SHIM}"; ${launch.command}`
  if (launch.remedy === "unknown") {
    const source = Option.match(launch.script, { onNone: () => "", onSome: (script) => ` runs ${script}` })
    return `\`${launch.command}\`${source}: cannot tell whether the Git operation selects another revision or restores files, or whether the launcher runs in the affected working tree. Use a literal revision target, spell out a file restore with \`git restore -- <path>\`, name the working directory explicitly, or export CHROME="${SHIM}" before a run over revisions.`
  }
  if (launch.oldCheckout === true) {
    const runner = Option.match(launch.script, { onNone: () => "runs", onSome: (script) => `runs ${script}, which runs` })
    return `\`${launch.command}\` ${runner} a launcher after selecting another Git revision, whose browser launchers may predate ${KEYCHAIN_FLAGS.join(" ")}, ${dialog}. Export CHROME before the whole command: export CHROME="${SHIM}"; ${launch.command}`
  }
  if (launch.remedy === "shim")
    return (
      `\`${launch.command}\` ${Option.match(launch.script, { onNone: () => "runs a bisect", onSome: (script) => `runs ${script}, a bisect or a run over other commits` })}, ` +
      `whose browser launchers may predate ${KEYCHAIN_FLAGS.join(" ")}, ${dialog}. ` +
      `Prefix it with CHROME="${SHIM}" (a launcher that reads CHROME, as Exact's and manna's do, then starts Chrome with both flags): CHROME="${SHIM}" ${launch.command}`
    )
  return (
    `\`${launch.command}\` ${starts(launch)} Chrome with a DevTools port or headless and without ${KEYCHAIN_FLAGS.join(" ")}: ` +
    `Chrome then reads its Safe Storage key from the login keychain, ${dialog}. ` +
    "Use Playwright for tests or the browse tool; never spawn a Chrome binary directly."
  )
}

/** A launch the guard refuses, with the words the model reads. */
export class KeychainPrompt extends Schema.TaggedError<KeychainPrompt>()("KeychainPrompt", {
  command: Schema.String,
  reason: Schema.String,
  candidate: Schema.optionalKey(Schema.Struct({ form: Schema.String, reason: Schema.String })),
}) {}

/** Preserve the original line, including quotes and wrappers; scope compound lines with an export. */
const shimForm = (command: string): string => {
  const assignment = `CHROME="${SHIM}"`
  if (/^[ \t]*git[ \t]+bisect[ \t]+run[ \t]+[^;&|\n\r()]+$/.test(command)) return `${assignment} ${command}`
  return `export ${assignment}; ${command}`
}

export const keychainBlock = (command: string, launch: BareLaunch): KeychainPrompt => {
  const reason = keychainReason(launch)
  if (launch.remedy === "flags" || launch.pathLimit) return new KeychainPrompt({ command, reason })
  return new KeychainPrompt({ command, reason, candidate: { form: shimForm(command), reason: formReason(launch) } })
}

const formReason = (launch: BareLaunch): string => {
  const source = Option.getOrElse(Option.map(launch.script, (path) => `The command runs ${path}. `), () => "")
  if (launch.opaqueContinuation) return `${source}Cannot tell what the program runs next in the affected working tree.`
  if (launch.remedy === "unknown") return `${source}Cannot tell whether the Git operation selects another revision or which tree the launcher runs in.`
  if (launch.oldCheckout) return `${source}The command runs a launcher after selecting another Git revision; its browser flags may be out of date.`
  return `${source}Historical Git revisions may have browser launchers without keychain-safe flags.`
}

/** What the model reads of the refusal. */
export const keychainMessage = (reason: string): string => renderRefusal("guard-keychain", reason)

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
// A script's imports are not read, and a wrapper that runs a bisect script
// under another name slips through: the shim prefix is the remedy there too.
import { Array as Arr, Option, Schema } from "effect"
import { basename, resolve } from "./path.ts"
import { expandWord, SHELLS, shellInput, shellScript, simpleCommands, type Word } from "./shell-line.ts"
import { gitSubcommand, type Place, type PlacedCommand, placedCommands } from "./verdict.ts"

/** The two flags that keep a Chrome off the login keychain: the mock keychain (macOS) and the plain password store (Linux). */
export const KEYCHAIN_FLAGS: ReadonlyArray<string> = ["--use-mock-keychain", "--password-store=basic"]

/** The shim a launcher that reads CHROME starts Chrome through, with both flags added. */
export const SHIM = "$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"

/** A Chrome program's name, its folder dropped: Google Chrome (for Testing, Canary…), Chromium, the headless shell, Brave, Edge. */
const CHROME_PROGRAM =
  /^(?:google[- ]chrome(?:[- ](?:stable|beta|dev|unstable|canary|for testing))?|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|brave(?:[- ]browser)?|microsoft edge|msedge)(?:\.app|\.exe)?$/i

/** A variable that names a Chrome binary, as a launch writes it: `$CHROME`, `${CHROMIUM_BIN}`. */
const CHROME_VARIABLE = /^\$\{?([A-Za-z_]*CHROM[A-Za-z_]*)\}?$/i

/** The programs that read or show a command line without running it: a Chrome named in theirs starts nothing. */
const READERS: ReadonlySet<string> = new Set([
  "echo", "printf", "grep", "rg", "ag", "pgrep", "pkill", "killall", "ps", "cat", "which", "type", "command", "man", "ls", "git", "lsof",
  "head", "tail", "less", "more", "shellcheck", "shfmt", "vi", "vim", "nvim", "nano", "emacs", "code",
])

/** A flag that opens Chrome's DevTools protocol or runs it headless. */
const opens = (flag: string): boolean => flag.startsWith("--remote-debugging-") || flag.startsWith("--headless")

/** Whether a path's last part names a Chrome program. */
const isChromePath = (path: string): boolean => CHROME_PROGRAM.test(path.slice(path.lastIndexOf("/") + 1))

/** Whether the line sets CHROME to the shim (`CHROME=…/chrome-mock-keychain cmd`, `export CHROME=…`). */
export const shimmed = (line: string): boolean => /(?:^|[\s;&|(])(?:export\s+)?CHROME=["']?[^\s"';&|]*chrome-mock-keychain\b/.test(line)

/** A prefix on Git only applies to Git, not to the separate launcher after it. */
const exportedShim = (line: string): boolean =>
  Option.exists(Arr.head(simpleCommands(line)), (words) => {
    const [command, ...assignments] = words
    return command?.text === "export" && assignments.some(({ text }) => text.startsWith("CHROME=") && basename(text.slice("CHROME=".length)) === basename(SHIM))
  })

/** What a refused launch needs: both flags on its list, or the shim before a bisect over old commits. */
export type Remedy = "flags" | "shim"

/** One launch the rule refuses: the command as the refusal names it, the script that starts Chrome when a script does, and its way through. */
export interface BareLaunch {
  readonly command: string
  readonly script: Option.Option<string>
  readonly remedy: Remedy
  readonly oldCheckout?: true
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

/** Actions that actually select or execute another Git revision, not words in a Git argument list. */
type RevisionAction = "run" | "select" | "detach" | "none"

const revisionAction = (head: string, args: ReadonlyArray<string>): RevisionAction => {
  if (head !== "git") return "none"
  const sub = gitSubcommand(args)
  if (sub.kind !== "command") return "none"
  if (sub.name === "bisect") {
    if (sub.rest[0] === "run") return "run"
    if (sub.rest[0] === "start") return "select"
  }
  if (sub.name === "worktree" && sub.rest[0] === "add") return "select"
  if (sub.name === "stash" && sub.rest[0] === "branch") return "select"
  if (sub.name !== "checkout" && sub.name !== "switch") return "none"
  const positional = Arr.takeWhile(sub.rest, (arg) => arg !== "--")
  if (positional.includes("--detach") || (positional.includes("-d") && sub.name === "switch")) return "detach"
  // `checkout <tree> -- <paths>` reads files from the tree without switching HEAD.
  if (positional.length + 1 < sub.rest.length) return "none"
  if (positional.some((arg) => !arg.startsWith("-") || arg === "-")) return "select"
  return "none"
}

/** The extensions of a script a runtime runs. */
const SCRIPT = /\.(?:[cm]?[jt]s|tsx|sh|bash|zsh)$/

/** The runtimes whose script the rule reads, and the options among theirs that take inline code. */
const RUNTIMES: ReadonlySet<string> = new Set(["bun", "node", "deno", "tsx", "ts-node"])
const INLINE: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"])
const RUNTIME_INFO: ReadonlySet<string> = new Set(["-h", "--help", "-v", "--version", "--check"])
const RUNTIME_VALUES: ReadonlySet<string> = new Set(["-r", "--require", "--import", "--preload", "--loader", "--env-file", "--cwd", "--config", "--conditions", "-C", "-c"])

/** Inline code a runtime is given. */
export const Inline = Schema.TaggedStruct("Inline", { code: Schema.String })
/** A script file a runtime runs, its path absolute. */
export const ScriptFile = Schema.TaggedStruct("ScriptFile", { path: Schema.String })
/** What a runtime command runs. */
export const Ran = Schema.Union([Inline, ScriptFile])
export type Ran = typeof Ran.Type

/** A shell variable's assignment: `NAME=value`. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

/** A variable's use in a word: `$NAME` or `${NAME}`. */
const USE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g

/** `text` with each variable `values` holds put in. */
const substituted = (text: string, values: ReadonlyMap<string, string>): string =>
  text.replace(USE, (use, name: string) => Option.getOrElse(Option.fromUndefinedOr(values.get(name)), () => use))

/**
 * The variables a line sets for the commands after it (`D=/tmp/run; bun $D/x.ts`, `export D=…`), each with the
 * variables set before it put in. Where in the line each is set is not read: the last one set wins.
 */
const variablesOf = (line: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>()
  for (const words of simpleCommands(line)) {
    const texts = words.map((word) => word.text)
    const assigned = Arr.dropWhile(texts, (text) => text === "export")
    if (assigned.length === 0 || !assigned.every((text) => ASSIGNMENT.test(text))) continue
    for (const [name, value] of assigned.flatMap((text) => Option.toArray(Option.fromNullishOr(ASSIGNMENT.exec(text)))).map((match) => [match[1], match[2]] as const))
      values.set(`${name}`, substituted(`${value}`, values))
  }
  return values
}

/** The JavaScript runtime's own options and entry point, never a path in the entry point's arguments. */
const runtimeEntry = (head: string, args: ReadonlyArray<Word>, canRun = true): Option.Option<Word | Ran> => {
  for (const [at, word] of args.entries()) {
    const text = word.text
    if (RUNTIME_INFO.has(text) || (head === "node" && text === "-c") || (head === "deno" && text === "check")) return Option.none()
    if (INLINE.has(text)) return Option.map(Arr.get(args, at + 1), (code) => Inline.make({ code: code.text }))
    if (text === "--") return Option.filter(Arr.get(args, at + 1), (entry) => SCRIPT.test(entry.text))
    if (RUNTIME_VALUES.has(text)) return runtimeEntry(head, args.slice(at + 2), canRun)
    if (text.startsWith("-")) continue
    if (canRun && (head === "bun" || head === "deno") && text === "run") return runtimeEntry(head, args.slice(at + 1), false)
    return Option.liftPredicate(word, (entry) => SCRIPT.test(entry.text))
  }
  return Option.none()
}

/** The script an executable or interpreter actually takes as its input. */
const entryOf = ({ head, executable, args }: PlacedCommand): Option.Option<Word | Ran> => {
  if (SHELLS.has(head)) {
    const input = shellInput(args)
    if (input.command || input.stdin || input.noexec) return Option.none()
    return Option.filter(Arr.head(input.operands), (word) => word.text !== "-")
  }
  if (RUNTIMES.has(head)) return runtimeEntry(head, args)
  if (head === "source" || head === ".") return Arr.head(args)
  return Option.map(Option.liftPredicate(executable, (program) => program.includes("/") && SCRIPT.test(head)),
    (text): Word => ({ text, bareStart: true, singleQuoted: false }))
}

const LAUNCHERS: ReadonlySet<string> = new Set(["make", "bunx", "npx", "playwright", "open"])
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["bun", "npm", "pnpm", "yarn"])
const PACKAGE_RUNS: ReadonlySet<string> = new Set(["run", "start", "test", "exec", "dlx"])

/** A putative browser launcher after a Git selection: an actual script, shell command, or runner, not a reader. */
const runsLauncher = (command: PlacedCommand): boolean => {
  const { head, args } = command
  if (LAUNCHERS.has(head) || isChromePath(head) || Option.isSome(entryOf(command))) return true
  if (PACKAGE_RUNNERS.has(head) && Option.exists(Arr.head(args), (word) => PACKAGE_RUNS.has(word.text))) return true
  if ((head === "go" || head === "cargo") && Option.exists(Arr.head(args), (word) => word.text === "run")) return true
  if (!SHELLS.has(head)) return false
  const input = shellInput(args)
  return input.command && !input.noexec
}

/** Whether the line runs a launcher after selecting a revision. */
const runsSelection = (commands: ReadonlyArray<PlacedCommand>): boolean => {
  let selected = false
  for (const command of commands) {
    if (selected && runsLauncher(command)) return true
    const action = revisionAction(command.head, command.args.map((word) => word.text))
    if (action === "select" || action === "detach") selected = true
  }
  return false
}

/** What a runtime of a line runs, with the command as the refusal names it, and whether the line sets CHROME to the shim. */
export interface RuntimeRun {
  readonly command: string
  readonly ran: Ran
  readonly shimmed: boolean
  readonly shell?: boolean
}

/** Each script a line executes (as a file or inline), in order. Tests and syntax checks do not supply script entry points. */
export const runtimeRuns = (line: string, place: Place): ReadonlyArray<RuntimeRun> => {
  const values = variablesOf(line)
  const shim = shimmed(line)
  return placedCommands(line, resolve("/", place.cwd), place.home).flatMap((placed) =>
    Option.toArray(Option.map(entryOf(placed), (entry): RuntimeRun => ({
      command: placed.command,
      ran: resolveEntry(entry, placed.runsIn, place.home, values),
      shimmed: shim,
      shell: SHELLS.has(placed.head) || placed.head === "source" || placed.head === ".",
    }))),
  )
}

const resolveEntry = (entry: Word | Ran, cwd: string, home: string, values: ReadonlyMap<string, string>): Ran => {
  if ("_tag" in entry) return entry
  return ScriptFile.make({ path: resolve(cwd, expandWord({ ...entry, text: substituted(entry.text, values) }, home, cwd)) })
}

/** Each command of `line` that starts Chrome for DevTools or headless without both keychain flags, or runs a bisect without the shim. */
export const bareLaunches = (line: string, place: Place): ReadonlyArray<BareLaunch> => {
  const shim = shimmed(line)
  const commands = placedCommands(line, resolve("/", place.cwd), place.home)
  const launches = commands.flatMap(({ head, args, command }): ReadonlyArray<BareLaunch> => {
    if (revisionAction(head, args.map((word) => word.text)) === "run" && !shim) return [{ command, script: Option.none(), remedy: "shim" }]
    if (SHELLS.has(head) || RUNTIMES.has(head)) return []
    const words: ReadonlyArray<Word> = [{ text: head, bareStart: true, singleQuoted: false }, ...args]
    return Option.toArray(Option.filter(chromeFlags(head, words, shim), bare)).map((): BareLaunch => ({ command, script: Option.none(), remedy: "flags" }))
  })
  if (launches.length === 0 && runsSelection(commands) && !exportedShim(line)) return [{ command: line, script: Option.none(), remedy: "shim", oldCheckout: true }]
  return launches
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

const shellRevision = (commands: ReadonlyArray<PlacedCommand>): boolean => commands.some(({ head, args }) => {
  const action = revisionAction(head, args.map((word) => word.text))
  return action === "run" || action === "detach"
}) || runsSelection(commands)

/** Keep the existing convention for an executed bisect driver even when it delegates its Git calls. */
const namedBisect = (ran: Ran): boolean => ran._tag === "ScriptFile" && /bisect/i.test(basename(ran.path))

const revisionInLine = (line: string): boolean => shellRevision(placedCommands(line, "/", "/"))

/** Only argv passed to a process counts. A detached selection stays guarded even when its next execution is indirect. */
const jsRevision = (text: string): boolean => {
  if (Array.from(text.matchAll(CALL)).some((match) => Option.exists(Option.fromUndefinedOr(match[1]), revisionInLine))) return true
  const script: Script = { arrays: arraysOf(text), chromes: new Set() }
  let selected = false
  for (const { name, open } of callsIn(text)) {
    if (name === "launch") continue
    if (name === "exec" || name === "execSync" || name === "sh") {
      const code = Option.map(Arr.head(topLevel(inside(text, open))), literalWord)
      if (Option.exists(code, revisionInLine)) return true
    }
    const action = spawned(text, open, script)
    if (Option.isNone(action)) continue
    const head = basename(literalWord(action.value.program))
    const words = topLevel(action.value.list).map(literalWord)
    if (SHELLS.has(head) && Option.exists(Option.fromUndefinedOr(shellScript(words.map((word) => bareWord(word)))), revisionInLine)) return true
    const revision = revisionAction(head, words)
    if (revision === "run" || revision === "detach" || (selected && head !== "" && !READERS.has(head))) return true
    if (revision === "select") selected = true
  }
  return false
}

const bareWord = (text: string): Word => ({ text, bareStart: true, singleQuoted: false })

/** How the refusal names what a runtime ran. */
const scriptName = (ran: Ran): string => {
  if (ran._tag === "Inline") return "its inline script"
  return ran.path
}

/** The launch a runtime run makes when its code starts a bare Chrome, or runs old commits without the shim; none when it does neither. */
export const scriptLaunch = (run: RuntimeRun, text: string): Option.Option<BareLaunch> => {
  const named = (remedy: Remedy): BareLaunch => ({ command: run.command, script: Option.some(scriptName(run.ran)), remedy })
  if (run.shell === true || /\.(?:ba|da|k|z)?sh$/.test(scriptName(run.ran)) || /^#![^\n]*\b(?:sh|bash|zsh|dash|ksh)\b/.test(text)) {
    const launches = bareLaunches(text, { cwd: "/", home: "/" })
    if (launches.some((launch) => launch.remedy === "flags")) return Option.some(named("flags"))
    if (!run.shimmed && (namedBisect(run.ran) || revisionInLine(text))) return Option.some(named("shim"))
    return Option.none()
  }
  if (scriptLaunchesBare(text)) return Option.some(named("flags"))
  if (!run.shimmed && (namedBisect(run.ran) || jsRevision(text))) return Option.some(named("shim"))
  return Option.none()
}

/** What a launch does, in the refusal's words. */
const starts = (launch: BareLaunch): string =>
  Option.match(launch.script, { onNone: () => "starts", onSome: (script) => `runs ${script}, which starts` })

/** Why the rule refuses `launch`, and the way through. */
export const keychainReason = (launch: BareLaunch): string => {
  const dialog = "and macOS puts a keychain dialog on the owner's screen at each launch of a Chrome without them"
  if (launch.oldCheckout === true)
    return `\`${launch.command}\` runs a launcher after selecting another Git revision, whose browser launchers may predate ${KEYCHAIN_FLAGS.join(" ")}, ${dialog}. Export CHROME before the whole command: export CHROME="${SHIM}"; ${launch.command}`
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
}) {}

/** What the model reads of the refusal. */
export const keychainMessage = (reason: string): string => `guard-keychain: ${reason}.`

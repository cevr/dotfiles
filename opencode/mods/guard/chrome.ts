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
// - A script a line runs (`bun x.ts`, `node x.mjs`, `bun -e '…'`) that hands
//   such a list to a Chrome it names itself: a spawn-like call whose program is
//   a Chrome path literal (or a name bound to one in the file), or a
//   Puppeteer/Playwright `launch` with `ignoreDefaultArgs: true`. A list a
//   script only reads (`args.includes('--headless')`), a help text, or a launch
//   of a browser the script asks another module for is not one: those are its
//   launcher's, held by that launcher (Exact's `chromium()` honours CHROME).
// - A bisect, or a script that checks out old commits (`git bisect run`, a
//   script named *bisect*, one that runs `git switch --detach` /
//   `git checkout --detach`): an old commit's browser launcher may predate the
//   flags, and only the CHROME shim reaches it. Refused unless the line sets
//   `CHROME=<…>/chrome-mock-keychain`, the way through it names.
// A script's imports are not read, and a wrapper that runs a bisect script
// under another name slips through: the shim prefix is the remedy there too.
import { Array as Arr, Option, Schema } from "effect"
import { resolve } from "./path.ts"
import { expandWord, simpleCommands, type Word } from "./shell-line.ts"
import { type Place, placedCommands } from "./verdict.ts"

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
const READERS: ReadonlySet<string> = new Set(["echo", "printf", "grep", "rg", "ag", "pgrep", "pkill", "killall", "ps", "cat", "which", "type", "man", "ls", "git", "lsof"])

/** A flag that opens Chrome's DevTools protocol or runs it headless. */
const opens = (flag: string): boolean => flag.startsWith("--remote-debugging-") || flag.startsWith("--headless")

/** Whether a path's last part names a Chrome program. */
const isChromePath = (path: string): boolean => CHROME_PROGRAM.test(path.slice(path.lastIndexOf("/") + 1))

/** Whether the line sets CHROME to the shim (`CHROME=…/chrome-mock-keychain cmd`, `export CHROME=…`). */
export const shimmed = (line: string): boolean => /(?:^|[\s;&|(])(?:export\s+)?CHROME=["']?[^\s"';&|]*chrome-mock-keychain\b/.test(line)

/** What a refused launch needs: both flags on its list, or the shim before a bisect over old commits. */
export type Remedy = "flags" | "shim"

/** One launch the rule refuses: the command as the refusal names it, the script that starts Chrome when a script does, and its way through. */
export interface BareLaunch {
  readonly command: string
  readonly script: Option.Option<string>
  readonly remedy: Remedy
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

/** Whether a git command runs a bisect (`git bisect run …`, `git -C x bisect run …`). */
const bisectRun = (head: string, args: ReadonlyArray<Word>): boolean => {
  const texts = args.map((word) => word.text)
  return head === "git" && Option.contains(Arr.get(texts, texts.indexOf("bisect") + 1), "run") && texts.includes("bisect")
}

/** The extensions of a script a runtime runs. */
const SCRIPT = /\.(?:[cm]?[jt]s|tsx|sh|bash|zsh)$/

/** The shells whose `-c` the line parser reads itself. */
const SHELL_RUNTIMES: ReadonlySet<string> = new Set(["sh", "bash", "zsh"])

/** The runtimes whose script the rule reads, and the options among theirs that take inline code. */
const RUNTIMES: ReadonlySet<string> = new Set(["bun", "node", "deno", "tsx", "ts-node", ...SHELL_RUNTIMES])
const INLINE: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"])

/** Inline code a runtime is given. */
export const Inline = Schema.TaggedStruct("Inline", { code: Schema.String })
/** A script file a runtime runs, its path absolute. */
export const ScriptFile = Schema.TaggedStruct("ScriptFile", { path: Schema.String })
/** What a runtime command runs. */
export const Ran = Schema.Union([Inline, ScriptFile])
export type Ran = typeof Ran.Type

/** The inline code after an `-e`-like option. */
const inlineOf = (args: ReadonlyArray<Word>): Option.Option<Ran> =>
  Option.flatMap(
    Arr.findFirstIndex(args, (word) => INLINE.has(word.text)),
    (at) => Option.map(Arr.get(args, at + 1), (word): Ran => Inline.make({ code: word.text })),
  )

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

/** The script file among a runtime's words: its first word with a script's extension, the line's variables put in. */
const fileOf = (args: ReadonlyArray<Word>, runsIn: string, home: string, values: ReadonlyMap<string, string>): Option.Option<Ran> =>
  Option.map(
    Arr.findFirst(args, (word) => !word.text.startsWith("-") && SCRIPT.test(word.text)),
    (word): Ran => ScriptFile.make({ path: resolve(runsIn, expandWord({ ...word, text: substituted(word.text, values) }, home, runsIn)) }),
  )

/** What a runtime of a line runs, with the command as the refusal names it, and whether the line sets CHROME to the shim. */
export interface RuntimeRun {
  readonly command: string
  readonly ran: Ran
  readonly shimmed: boolean
}

/** Whether a runtime's words run its test runner (`bun test`): a repository's tests, held by its lint, not a scratch probe. */
const runsTests = (args: ReadonlyArray<Word>): boolean => Option.contains(Arr.findFirst(args, (word) => !word.text.startsWith("-")).pipe(Option.map((word) => word.text)), "test")

/** Whether a runtime's words run nothing the rule reads: `bun test`, or a shell's `-c`, whose commands the line parser reads. */
const runsNone = (head: string, args: ReadonlyArray<Word>): boolean => runsTests(args) || (SHELL_RUNTIMES.has(head) && args.some((word) => word.text === "-c"))

/** Each script a line runs through a runtime (`bun x.ts`, `bun run x.ts`, `node x.mjs`, `sh x.sh`, `bun -e '…'`), in order; `bun test` runs none. */
export const runtimeRuns = (line: string, place: Place): ReadonlyArray<RuntimeRun> => {
  const values = variablesOf(line)
  const shim = shimmed(line)
  return placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command, runsIn }) => {
    if (!RUNTIMES.has(head) || runsNone(head, args)) return []
    const ran = Option.orElse(inlineOf(args), () => fileOf(args, runsIn, place.home, values))
    return Option.toArray(Option.map(ran, (each): RuntimeRun => ({ command, ran: each, shimmed: shim })))
  })
}

/** Each command of `line` that starts Chrome for DevTools or headless without both keychain flags, or runs a bisect without the shim. */
export const bareLaunches = (line: string, place: Place): ReadonlyArray<BareLaunch> => {
  const shim = shimmed(line)
  return placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command }): ReadonlyArray<BareLaunch> => {
    if (bisectRun(head, args) && !shim) return [{ command, script: Option.none(), remedy: "shim" }]
    const words: ReadonlyArray<Word> = [{ text: head, bareStart: true, singleQuoted: false }, ...args]
    return Option.toArray(Option.filter(chromeFlags(head, words, shim), bare)).map((): BareLaunch => ({ command, script: Option.none(), remedy: "flags" }))
  })
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

/** A spawn-like call: Node's and Bun's spawners and execa. */
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|execa|execaSync)\s*\(\s*/g

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
  Array.from(text.matchAll(SPAWN), (match) => match.index + match[0].length - 1).some((open) =>
    Option.match(spawned(text, open, script), { onNone: () => false, onSome: ({ program, list }) => isChromeExpression(program, script) && bare(flagsOf(list, script)) }),
  )

/** A Puppeteer or Playwright launch: these add both keychain flags themselves unless told to drop their defaults. */
const LAUNCH = /\blaunch\s*\(\s*\{/g

/** Whether a Puppeteer/Playwright launch drops its default flags (`ignoreDefaultArgs: true`) and passes no keychain flags itself. */
const launchesBare = (text: string, script: Script): boolean =>
  Array.from(text.matchAll(LAUNCH), (match) => inside(text, match.index + match[0].length - 1)).some((options) => {
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

/** A checkout of another commit in a script's text: a detached switch or checkout, as a shell line or a spawn's list. */
const OLD_CHECKOUT = /\bgit\b[^\n]*?\b(?:switch|checkout)\s+--detach\b|["'](?:switch|checkout)["']\s*,\s*["']--detach["']|\bgit\s+bisect\s+run\b|["']bisect["']\s*,\s*["']run["']/

/** Whether a script runs a bisect or other commits' code: named for it, or checking out commits detached. */
export const scriptRunsOldCommits = (ran: Ran, text: string): boolean =>
  (ran._tag === "ScriptFile" && /bisect/i.test(ran.path.slice(ran.path.lastIndexOf("/") + 1))) || OLD_CHECKOUT.test(text)

/** How the refusal names what a runtime ran. */
const scriptName = (ran: Ran): string => {
  if (ran._tag === "Inline") return "its inline script"
  return ran.path
}

/** The launch a runtime run makes when its code starts a bare Chrome, or runs old commits without the shim; none when it does neither. */
export const scriptLaunch = (run: RuntimeRun, text: string): Option.Option<BareLaunch> => {
  const named = (remedy: Remedy): BareLaunch => ({ command: run.command, script: Option.some(scriptName(run.ran)), remedy })
  if (scriptLaunchesBare(text)) return Option.some(named("flags"))
  if (!run.shimmed && scriptRunsOldCommits(run.ran, text)) return Option.some(named("shim"))
  return Option.none()
}

/** What a launch does, in the refusal's words. */
const starts = (launch: BareLaunch): string =>
  Option.match(launch.script, { onNone: () => "starts", onSome: (script) => `runs ${script}, which starts` })

/** Why the rule refuses `launch`, and the way through. */
export const keychainReason = (launch: BareLaunch): string => {
  const dialog = "and macOS puts a keychain dialog on the owner's screen at each launch of a Chrome without them"
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

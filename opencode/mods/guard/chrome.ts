// The guard's keychain rule: a Chrome started by hand for a DevTools port or
// headless must pass `--use-mock-keychain` and `--password-store=basic`.
// Without them a Chrome reads its "Safe Storage" key from the login keychain
// at startup; Chrome for Testing is not on that item's access list, so macOS
// puts a keychain dialog on the owner's screen for each launch (2026-11-22:
// seven dialogs in twelve minutes, every one from Playwright's Chrome for
// Testing; the owner: "Can we put the mock keychain so I don't keep getting
// this pop-up?"). With the mock keychain Chrome never reads the item, and the
// plain password store does the same for Linux's keyrings.
//
// Two catches. A command line that runs a Chrome binary (a Chrome, Chromium,
// Chrome for Testing or headless-shell program, a `$CHROME`-like variable, or
// `open -a "Google Chrome" --args …`) with `--remote-debugging-*` or
// `--headless*` and without both flags is refused. The owner's own Chrome
// start opens no DevTools port, so it is never matched. And a script a line
// runs (`bun x.ts`, `bun run x.ts`, `node x.mjs`, `bun -e '…'`) is read: one
// that names a Chrome and a DevTools or headless flag but not both keychain
// flags is refused too, as a scratch probe that spawns Chrome itself is the
// launch this rule exists for. A script's imports are not read: a repository's
// own launchers are held by its lint (`dotfiles/chrome-mock-keychain`).
//
// The refusal names the launcher every agent can use instead:
// `scripts/chrome.ts` of the dotfiles' opencode/ (its CLI or `openChrome`),
// agent-browser or Playwright, each of which passes both flags.
import { Array as Arr, Option, Schema } from "effect"
import { resolve } from "./path.ts"
import { expandWord, simpleCommands, type Word } from "./shell-line.ts"
import { type Place, placedCommands } from "./verdict.ts"

/** The two flags that keep a Chrome off the login keychain: the mock keychain (macOS) and the plain password store (Linux). */
export const KEYCHAIN_FLAGS: ReadonlyArray<string> = ["--use-mock-keychain", "--password-store=basic"]

/** Where the launcher that passes them lives. */
export const LAUNCHER = "~/Developer/personal/dotfiles/opencode/scripts/chrome.ts"

/** A Chrome program's name, its folder dropped: Google Chrome (for Testing, Canary…), Chromium, the headless shell, Brave, Edge. */
const CHROME_PROGRAM =
  /^(?:google[- ]chrome(?:[- ](?:stable|beta|dev|unstable|canary|for testing))?|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|brave(?:[- ]browser)?|microsoft edge|msedge)(?:\.app|\.exe)?$/i

/** A variable that names a Chrome binary, as a launch writes it: `$CHROME`, `${CHROMIUM_BIN}`. */
const CHROME_VARIABLE = /^\$\{?[A-Za-z_]*CHROM/i

/** The programs that read or show a command line without running it: a Chrome named in theirs starts nothing. */
const READERS: ReadonlySet<string> = new Set(["echo", "printf", "grep", "rg", "ag", "pgrep", "pkill", "killall", "ps", "cat", "which", "type", "man", "ls", "git", "lsof"])

/** A flag that opens Chrome's DevTools protocol or runs it headless. */
const opens = (flag: string): boolean => flag.startsWith("--remote-debugging-") || flag.startsWith("--headless")

/** Whether a word names a Chrome program or a variable holding one. */
const namesChrome = (word: Word): boolean => CHROME_PROGRAM.test(word.text.slice(word.text.lastIndexOf("/") + 1)) || CHROME_VARIABLE.test(word.text)

/** One launch the rule refuses: the command as the refusal names it, and the script that starts Chrome, when a script does. */
export interface BareLaunch {
  readonly command: string
  readonly script: Option.Option<string>
}

/** Whether a launch's flags open DevTools or headless without both keychain flags. */
const bare = (flags: ReadonlyArray<string>): boolean => flags.some(opens) && !KEYCHAIN_FLAGS.every((flag) => flags.includes(flag))

/** The flags a command passes a Chrome it names: every word after the first that names one; none when it names none. */
const chromeFlags = (head: string, words: ReadonlyArray<Word>): Option.Option<ReadonlyArray<string>> => {
  if (READERS.has(head)) return Option.none()
  return Option.map(Arr.findFirstIndex(words, namesChrome), (at) => words.slice(at + 1).map((word) => word.text))
}

/** The extensions of a script a runtime runs. */
const SCRIPT = /\.(?:[cm]?[jt]s|tsx)$/

/** The runtimes whose script the rule reads, and the options among theirs that take inline code. */
const RUNTIMES: ReadonlySet<string> = new Set(["bun", "node", "deno", "tsx", "ts-node"])
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

/** What a runtime of a line runs, with the command as the refusal names it. */
export interface RuntimeRun {
  readonly command: string
  readonly ran: Ran
}

/** Whether a runtime's words run its test runner (`bun test`): a repository's tests, held by its lint, not a scratch probe. */
const runsTests = (args: ReadonlyArray<Word>): boolean => Option.contains(Arr.findFirst(args, (word) => !word.text.startsWith("-")).pipe(Option.map((word) => word.text)), "test")

/** Each script a line runs through a runtime (`bun x.ts`, `bun run x.ts`, `node x.mjs`, `bun -e '…'`), in order; `bun test` runs none. */
export const runtimeRuns = (line: string, place: Place): ReadonlyArray<RuntimeRun> => {
  const values = variablesOf(line)
  return placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command, runsIn }) => {
    if (!RUNTIMES.has(head) || runsTests(args)) return []
    const ran = Option.orElse(inlineOf(args), () => fileOf(args, runsIn, place.home, values))
    return Option.toArray(Option.map(ran, (each) => ({ command, ran: each })))
  })
}

/** Each command of `line` that starts Chrome for DevTools or headless without both keychain flags. */
export const bareLaunches = (line: string, place: Place): ReadonlyArray<BareLaunch> =>
  placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command }) => {
    const words: ReadonlyArray<Word> = [{ text: head, bareStart: true, singleQuoted: false }, ...args]
    return Option.toArray(Option.filter(chromeFlags(head, words), bare)).map((): BareLaunch => ({ command, script: Option.none() }))
  })

/** A Chrome named in a script: a program, an app bundle, Playwright's and agent-browser's builds. */
const SCRIPT_CHROME = /Google Chrome|Chrome for Testing|chrome-headless-shell|headless_shell|chromium|google-chrome|msedge|Brave Browser|\bchrome\b/i

/**
 * A DevTools or headless flag as a launch writes it in a script: a whole string literal (quoted or a template) that
 * is an element of a list, after `[` or `,`. A flag inside a longer string (a help text, a comment) or one a script
 * only looks for (`args.includes('--headless')`) is no launch.
 */
const SCRIPT_OPENS = /(?:^|[[,])\s*(["'`])--(?:remote-debugging-(?:port|pipe|address)|headless)\b[^"'`\n]*\1/m

/** Whether a script's text starts a Chrome for DevTools or headless without both keychain flags: it names a Chrome and lists such a flag, and not both keychain flags. */
export const scriptLaunchesBare = (text: string): boolean =>
  SCRIPT_CHROME.test(text) && SCRIPT_OPENS.test(text) && !KEYCHAIN_FLAGS.every((flag) => text.includes(flag))

/** The launch a runtime run makes when its code starts a bare Chrome; none when it does not. */
export const scriptLaunch = (run: RuntimeRun, text: string): Option.Option<BareLaunch> =>
  Option.map(
    Option.liftPredicate(text, scriptLaunchesBare),
    (): BareLaunch => ({ command: run.command, script: Option.some(scriptName(run.ran)) }),
  )

/** How the refusal names what a runtime ran. */
const scriptName = (ran: Ran): string => {
  if (ran._tag === "Inline") return "its inline script"
  return ran.path
}

/** What a launch does, in the refusal's words. */
const starts = (launch: BareLaunch): string =>
  Option.match(launch.script, { onNone: () => "starts", onSome: (script) => `runs ${script}, which starts` })

/** Why the rule refuses `launch`, and what to run instead. */
export const keychainReason = (launch: BareLaunch): string =>
  `\`${launch.command}\` ${starts(launch)} Chrome with a DevTools port or headless and without ${KEYCHAIN_FLAGS.join(" ")}: ` +
  "Chrome then reads its Safe Storage key from the login keychain, and macOS puts a keychain dialog on the owner's screen at each launch. " +
  `Start Chrome with \`bun ${LAUNCHER} launch [--proxy …] [--resolver-rules …] -- <flags>\` (it prints the DevTools endpoint and pid; \`stop <pid>\` ends it), ` +
  "its `openChrome` from a script, agent-browser or Playwright, which pass both flags; or add both flags to the launch"

/** A launch the guard refuses, with the words the model reads. */
export class KeychainPrompt extends Schema.TaggedError<KeychainPrompt>()("KeychainPrompt", {
  command: Schema.String,
  reason: Schema.String,
}) {}

/** What the model reads of the refusal. */
export const keychainMessage = (reason: string): string => `guard-keychain: ${reason}.`

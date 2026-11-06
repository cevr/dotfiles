// A shell command in a few words, and whether it only waits. A row never
// shows a one-liner whole: it shows the call's own `description` when the
// model gave one, else the command's main word and what it acts on.
//
//   cd ~/w && flock /home/x/.cache/gate.lock ./scripts/gate.sh  →  flock gate.lock ./scripts/gate.sh
//   for i in $(seq 1 19); do [ -s $D/gate.log ] && break; sleep 30; done  →  polling gate.log  (a wait)
//
// The wait rule: a shell call waits, rather than works, when its description
// opens with a waiting verb (`Wait for the gate`, `Poll the log`, `Sleep`),
// or its command is a loop (for, while, until) that sleeps, or every command
// in it only sleeps or waits (`sleep 600`, `wait`). Anything else works:
// `flock gate.lock ./gate.sh` may queue on its lock, but the call does not
// say which half it is in, so it reads as working.

/** One simple command of a line: its words, quotes taken off, the shell keyword that led it (`do`, `then`) dropped. */
type Simple = { readonly keyword?: string; readonly words: ReadonlyArray<string> }

const KEYWORDS = new Set(["for", "while", "until", "do", "done", "if", "then", "else", "elif", "fi", "!", "{", "}", "(", ")"])
const LOOPS = new Set(["for", "while", "until"])

/**
 * The simple commands of a line, split at `;`, `&&`, `||`, `|`, `&` and new
 * lines outside quotes and `$( )`. Good enough to name a command, not to run one.
 */
export function commands(line: string): ReadonlyArray<Simple> {
  const out: Simple[] = []
  let words: string[] = []
  let word = ""
  let started = false
  let quote: "'" | '"' | undefined
  let depth = 0
  const endWord = () => {
    if (started) words.push(word)
    word = ""
    started = false
  }
  const endCommand = () => {
    endWord()
    let keyword: string | undefined
    while (words.length > 0 && KEYWORDS.has(words[0] ?? "")) keyword = words.shift()
    if (words.length > 0 || keyword !== undefined) out.push({ ...(keyword === undefined ? {} : { keyword }), words })
    words = []
  }
  const chars = Array.from(line)
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at] ?? ""
    if (quote) {
      if (char === quote) quote = undefined
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "$" && chars[at + 1] === "(") depth++
    if (depth > 0) {
      if (char === ")") depth--
      word += char
      started = true
      continue
    }
    if (char === "\\" && at + 1 < chars.length) {
      word += chars[++at]
      started = true
      continue
    }
    // A redirection's `&` (`2>&1`, `&>`) is part of its word.
    if (char === "&" && (/[<>]$/.test(word) || chars[at + 1] === ">")) {
      word += char
      started = true
      continue
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      endCommand()
      if ((char === "|" || char === "&") && chars[at + 1] === char) at++
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      continue
    }
    word += char
    started = true
  }
  endCommand()
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Commands that set the stage or report, never the work itself. */
const SETUP = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "echo", "printf", "date", "uptime", "ulimit", "umask", "trap", "local", "shopt"])
/** Commands that only wait. */
const IDLE = new Set(["sleep", "wait"])
/** Words that run the command after them, and how many of their own arguments to drop. */
const WRAPPERS: Readonly<Record<string, number>> = { env: 0, nice: 0, nohup: 0, time: 0, sudo: 0, command: 0, exec: 0, stdbuf: 0, caffeinate: 0, timeout: 1, "systemd-run": 0 }
/** Flags of a wrapper that take the next word as their value. */
const VALUED = new Set(["-p", "--property", "-u", "--unit", "-E", "--setenv", "--slice", "--description", "-M", "--machine", "--uid", "--gid", "--nice", "--working-directory", "-n", "-s", "-k", "--signal", "--kill-after"])

/** The words of a command past any leading assignments and wrappers (`env X=1 timeout 60 bun test` → `bun test`). */
function unwrap(words: ReadonlyArray<string>): ReadonlyArray<string> {
  let rest = [...words]
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? "")) rest = rest.slice(1)
    const head = rest[0]
    const drop = head === undefined ? undefined : WRAPPERS[head]
    if (drop === undefined) return rest
    rest = rest.slice(1)
    while (rest.length > 0 && (rest[0] ?? "").startsWith("-")) rest = rest.slice(VALUED.has(rest[0] ?? "") ? 2 : 1)
    rest = rest.slice(drop)
  }
}

/** A word as a row shows it: a path past a variable or an absolute directory by its last part, a long word cut. */
function shown(word: string): string {
  const path = /^(?:\$\{?\w+\}?|~|\/)/.test(word) && word.includes("/") ? (word.split("/").findLast(Boolean) ?? word) : word
  return path.length > 32 ? `${path.slice(0, 31)}…` : path
}

const isFlag = (word: string) => word.startsWith("-")
/** A redirection: `>`, `2>&1`, `>>log`, `<in`. */
const isRedirect = (word: string) => /^(?:\d*|&)(?:>>?|<)/.test(word)

/** A command's operands: its words past its flags and redirections, a bare redirection's target too. */
function operands(words: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = []
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ""
    if (isRedirect(word)) {
      if (/^(?:\d*|&)(?:>>?|<)&?$/.test(word)) at++
      continue
    }
    if (!isFlag(word)) out.push(word)
  }
  return out
}
const isWork = (command: Simple) => {
  const words = unwrap(command.words)
  return words.length > 0 && !SETUP.has(words[0] ?? "")
}
const isLoop = (command: Simple) => command.keyword !== undefined && LOOPS.has(command.keyword)
const head = (command: Simple) => unwrap(command.words)[0] ?? ""

/** A shell `-c` script's command, when a command only runs one (`bash -c "bun test"` → `bun test`). */
function script(words: ReadonlyArray<string>): string | undefined {
  const [name = "", ...rest] = words
  if (!/^(?:ba|z|da|k)?sh$/.test(name)) return undefined
  const at = rest.findIndex((word) => /^-\w*c$/.test(word))
  return at < 0 ? undefined : rest[at + 1]
}

/** Whether a description says the call waits: it opens with `wait`, `poll` or `sleep`. */
export const waitingWords = (description: string) => /^\s*(?:wait|waits|waiting|poll|polls|polling|sleep|sleeps|sleeping)\b/i.test(description)

/**
 * Whether a command only waits: a loop that sleeps (a poll), or nothing but
 * `sleep` and `wait` past its setup and tests.
 */
export function waits(command: string): boolean {
  const parts = commands(command)
  if (parts.some(isLoop) && parts.some((part) => head(part) === "sleep")) return true
  const work = parts.filter((part) => isWork(part) && !["[", "[[", "test"].includes(head(part)))
  return work.length > 0 && work.every((part) => IDLE.has(head(part)))
}

/** What a poll loop watches: the first file it names, by its last part. */
function watched(command: string): string | undefined {
  for (const part of commands(command))
    for (const word of part.words)
      if (!isFlag(word) && !ASSIGNMENT.test(word) && !word.startsWith("$(") && /\/|\.\w{1,8}$/.test(word)) return shown(word)
  return undefined
}

/**
 * A command in a few words: its main command (the first past its setup and
 * wrappers) and up to two of that command's operands, paths by their last
 * part, `…` when more commands follow. A poll loop reads `polling <file>`.
 */
export function brief(command: string): string {
  const line = command.trim()
  if (!line) return ""
  const parts = commands(line)
  if (parts.some(isLoop) && waits(line)) {
    const file = watched(line)
    return file ? `polling ${file}` : "polling"
  }
  const at = parts.findIndex(isWork)
  const main = parts[at] ?? parts[0]
  if (!main) return ""
  const words = unwrap(main.words)
  const inner = script(words)
  if (inner !== undefined) return brief(inner)
  const [name = "", ...rest] = words
  const more = parts.slice(at + 1).some(isWork) ? " …" : ""
  return [name, ...operands(rest).slice(0, 2).map(shown)].join(" ") + more
}

/** A shell call's input in a few words: its description when it gave one, else `brief` of its command. */
export function label(input: Readonly<Record<string, unknown>>): string {
  const description = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim() : ""
  if (description) return description
  return brief(typeof input.command === "string" ? input.command : "")
}

/** What a shell call does: runs a command, or checks, waits on, kills or lists the session's shells. */
export type ShellAction = "run" | "check" | "wait" | "kill" | "list"

const ACTIONS: ReadonlySet<string> = new Set<ShellAction>(["run", "check", "wait", "kill", "list"])

/**
 * A shell call's action: its `action` field (`run` when it gives a command
 * and no action). Older transcripts' calls named it by flag, and read the
 * same: `{ list: true }` lists, `{ id, kill: true }` kills, `{ id, wait }`
 * waits, `{ id }` checks.
 */
export function shellAction(input: Readonly<Record<string, unknown>>): ShellAction {
  if (typeof input.action === "string" && ACTIONS.has(input.action)) return input.action as ShellAction
  if (input.command !== undefined) return "run"
  if (input.list === true) return "list"
  if (typeof input.id !== "string") return "run"
  if (input.kill === true) return "kill"
  if (input.wait !== undefined) return "wait"
  return "check"
}

/** Whether a shell call's input waits: it waits on a shell, its description says so, or its command only waits. */
export function waitsInput(input: Readonly<Record<string, unknown>>): boolean {
  if (shellAction(input) === "wait") return true
  return (typeof input.description === "string" && waitingWords(input.description)) || (typeof input.command === "string" && waits(input.command))
}

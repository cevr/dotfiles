// The guard's rule for kills by pattern: `pkill`, `killall`, and a `kill`
// fed by `pgrep` or `pidof`, are refused when their pattern matches an
// OpenCode process on this machine now: the server the call runs on, or a
// process whose program is named `opencode…` (a TUI, another server, a
// kernel worker of an installed build). A `kill -1` is refused outright: it
// signals every process the user owns. The way out the refusal names is the
// one that cannot miss: list the matches and kill the PID you mean.
//
// One `bun test` on the workbox grew to 38.5 GB on 2026-11-06 and an agent's
// `pkill -f` cleanup could as easily have taken the server down; this rule is
// the second half of that lesson (mods/shell-policy is the first).
//
// What runs on the machine is the one fact from outside; the model asks the
// `Processes` contract (service.ts) only when a line kills by pattern.
import { Allow, Deny, type Verdict } from "./verdict.ts"
import { runningWords, SHELLS, shellScript, simpleCommands } from "./shell-line.ts"

/** A process as `ps` shows it: its id, its name (`comm`) and its full command line. */
export interface ProcessInfo {
  readonly pid: number
  readonly name: string
  readonly args: string
}

/** What one pattern of a kill selects: the name or the full command line, a regular expression or one exact name. */
export interface KillPattern {
  /** The simple command that kills, as the refusal names it. */
  readonly command: string
  readonly pattern: string
  /** `full`: the whole command line (`pkill -f`); `name`: the program's name. */
  readonly field: "full" | "name"
  /** The pattern is the whole name or line (`killall`, `pkill -x`, `pidof`), not a regular expression found in it. */
  readonly exact: boolean
  readonly ignoreCase: boolean
}

/** What a line asks of the kill rule. */
export type KillFinding =
  | { readonly _tag: "Pattern"; readonly target: KillPattern }
  /** `kill -1`: every process the user owns. */
  | { readonly _tag: "Broadcast"; readonly command: string }

/** Signal names `kill`, `pkill` and `killall` take as `-NAME` (with or without `SIG`). */
const SIGNALS: ReadonlySet<string> = new Set(
  "HUP INT QUIT ILL TRAP ABRT IOT BUS EMT FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO POLL PWR INFO SYS".split(" "),
)

/** Whether `text` is a `-SIGNAL` option, `-9` or `-KILL`; `0` when it is signal 0, which only checks. */
const signalOption = (text: string): "kill" | "zero" | undefined => {
  if (!text.startsWith("-") || text.length < 2) return undefined
  const name = text.slice(1).toUpperCase().replace(/^SIG/, "")
  if (/^\d+$/.test(name)) return Number(name) === 0 ? "zero" : "kill"
  return SIGNALS.has(name) || /^RTM(IN|AX)/.test(name) ? "kill" : undefined
}

/** `pgrep`/`pkill` options that take the next word as their value. */
const PGREP_VALUE: ReadonlySet<string> = new Set(["-F", "-G", "-M", "-N", "-P", "-U", "-g", "-s", "-t", "-u", "-r", "-O", "--signal", "--pidfile", "--parent", "--group", "--uid", "--euid", "--session", "--terminal", "--ns", "--nslist", "--runstates", "--older", "--pgroup"])
/** Options that pick processes by PID (a parent or a pidfile): the agent named the PIDs, so the pattern alone never reaches the server. */
const PGREP_BY_PID: ReadonlySet<string> = new Set(["-P", "-F", "--parent", "--pidfile"])

/** `pgrep`/`pkill`'s pattern and how it matches, or undefined when the call picks by PID or sends signal 0. */
const pgrepPattern = (command: string, args: ReadonlyArray<string>, killing: boolean): KillPattern | undefined => {
  let full = false
  let exact = false
  let ignoreCase = false
  let pattern: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index] ?? ""
    if (pattern !== undefined) continue
    if (killing && signalOption(text) === "zero") return undefined
    if (killing && signalOption(text) === "kill") continue
    if (text === "--") {
      pattern = args[index + 1] ?? ""
      continue
    }
    const option = text.split("=")[0] ?? text
    if (PGREP_BY_PID.has(option)) return undefined
    if (option === "--signal") {
      const value = text.includes("=") ? text.slice(text.indexOf("=") + 1) : args[index + 1]
      if (value !== undefined && /^(SIG)?0$/i.test(value)) return undefined
    }
    if (PGREP_VALUE.has(text)) {
      index += 1
      continue
    }
    if (text.startsWith("--")) {
      if (text === "--full") full = true
      if (text === "--exact") exact = true
      if (text === "--ignore-case") ignoreCase = true
      continue
    }
    if (text.startsWith("-") && text.length > 1) {
      // A run of short flags, as getopt reads it: one that takes a value takes the rest of the word, or the next word.
      for (const [at, letter] of [...text.slice(1)].entries()) {
        if (PGREP_BY_PID.has(`-${letter}`)) return undefined
        if (PGREP_VALUE.has(`-${letter}`)) {
          if (at === text.length - 2) index += 1
          break
        }
        if (letter === "f") full = true
        if (letter === "x") exact = true
        if (letter === "i") ignoreCase = true
      }
      continue
    }
    pattern = text
  }
  // With no pattern, `pkill -u me` takes every process its other options pass: the server among them.
  return { command, pattern: pattern ?? "", field: full ? "full" : "name", exact: exact && pattern !== undefined, ignoreCase }
}

/** `killall` options that take the next word as their value (psmisc's and macOS's). */
const KILLALL_VALUE: ReadonlySet<string> = new Set(["-s", "-u", "-o", "-y", "-n", "-Z", "-c", "-t", "--signal", "--user", "--older-than", "--younger-than", "--ns", "--context"])

/** Each name `killall` is given, matched whole, or as a regular expression under `-r` (psmisc) or `-m` (macOS). */
const killallPatterns = (command: string, args: ReadonlyArray<string>): ReadonlyArray<KillPattern> => {
  let regex = false
  let ignoreCase = false
  const names: Array<string> = []
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index] ?? ""
    if (signalOption(text) === "zero") return []
    if (signalOption(text) !== undefined) continue
    if (KILLALL_VALUE.has(text)) {
      if ((text === "-s" || text === "--signal") && /^(SIG)?0$/i.test(args[index + 1] ?? "")) return []
      index += 1
      continue
    }
    if (text === "--regexp") regex = true
    else if (text === "--ignore-case") ignoreCase = true
    else if (text.startsWith("-") && text.length > 1) {
      if (/[rm]/.test(text.slice(1))) regex = true
      if (text.slice(1).includes("I")) ignoreCase = true
    } else names.push(text)
  }
  return names.map((pattern) => ({ command, pattern, field: "name", exact: !regex, ignoreCase }))
}

/** Whether `kill`'s arguments signal `-1`, every process the user owns. */
const broadcasts = (args: ReadonlyArray<string>): boolean => {
  // The first word, when it is an option, is the signal (`kill -1 123` sends HUP to 123); the rest are PIDs.
  const first = args[0] ?? ""
  // `kill -1` alone names no signal and no PID but -1: read it as the PID, the worse of the two.
  if (first === "-1" && args.length === 1) return true
  const start = first === "-s" || first === "-n" ? 2 : first.startsWith("-") ? 1 : 0
  return args.slice(start).includes("-1")
}

/** How deep `sh -c` and `eval` are followed. */
const MAX_DEPTH = 4

/** Each simple command of a line, as its running words' texts, with the scripts of `sh -c` and `eval` read in. */
const commandsOf = (line: string, depth: number): ReadonlyArray<ReadonlyArray<string>> =>
  // A backquote runs a command of its own: read it as one.
  simpleCommands(line.replaceAll("`", ";")).flatMap((words) => {
    const running = runningWords(words)
    const texts = running.map((word) => word.text)
    const head = texts[0]?.split("/").pop()
    const script =
      depth < MAX_DEPTH ? (head !== undefined && SHELLS.has(head) ? shellScript(running.slice(1)) : head === "eval" ? texts.slice(1).join(" ") : undefined) : undefined
    return [texts, ...(script === undefined ? [] : commandsOf(script, depth + 1))]
  })

/** Whether a command sends a signal: `kill`, or `xargs` running `kill`. */
const killsByPid = (texts: ReadonlyArray<string>): boolean => {
  const head = texts[0]?.split("/").pop()
  if (head === "kill") return true
  return head === "xargs" && texts.slice(1).some((text) => text.split("/").pop() === "kill")
}

/** What a line asks of the kill rule: each pattern it kills by, and each `kill -1`. */
export const killFindings = (line: string): ReadonlyArray<KillFinding> => {
  const commands = commandsOf(line, 0)
  // `kill $(pgrep -f x)` and `pgrep x | xargs kill`: the line's pgrep and pidof pick what its kill signals.
  const fed = commands.some(killsByPid)
  const findings: Array<KillFinding> = []
  for (const texts of commands) {
    const head = texts[0]?.split("/").pop()
    const args = texts.slice(1)
    const command = texts.join(" ")
    if (head === "kill" && broadcasts(args)) findings.push({ _tag: "Broadcast", command })
    if (head === "pkill") {
      const target = pgrepPattern(command, args, true)
      if (target !== undefined) findings.push({ _tag: "Pattern", target })
    }
    if (head === "killall") for (const target of killallPatterns(command, args)) findings.push({ _tag: "Pattern", target })
    if (fed && head === "pgrep") {
      const target = pgrepPattern(command, args, false)
      if (target !== undefined) findings.push({ _tag: "Pattern", target })
    }
    if (fed && head === "pidof")
      for (const name of args.filter((text) => !text.startsWith("-"))) findings.push({ _tag: "Pattern", target: { command, pattern: name, field: "name", exact: true, ignoreCase: false } })
  }
  return findings
}

/** Whether the line kills by pattern, so the verdict needs the machine's processes. */
export const killsByPattern = (line: string): boolean => killFindings(line).some((finding) => finding._tag === "Pattern")

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The names a process goes by: its `comm` and its program's file name (Linux cuts `comm` to 15 characters). */
const namesOf = (process: ProcessInfo): ReadonlyArray<string> => [baseName(process.name), baseName(process.args.split(" ")[0] ?? "")]

/** Whether `process` is OpenCode: the server the guard runs in, or a program named `opencode…`. */
export const isOpenCode = (process: ProcessInfo, server: number): boolean =>
  process.pid === server || namesOf(process).some((name) => name.toLowerCase().startsWith("opencode"))

/** Whether `target` selects `process`, as pgrep, pkill and killall read their patterns; undefined when the pattern is no regular expression this reader can run. */
export const selects = (target: KillPattern, process: ProcessInfo): boolean | undefined => {
  const subjects = target.field === "full" ? [process.args] : namesOf(process)
  if (target.exact) {
    const fold = (text: string) => (target.ignoreCase ? text.toLowerCase() : text)
    return subjects.some((subject) => fold(subject) === fold(target.pattern))
  }
  try {
    const pattern = new RegExp(target.pattern, target.ignoreCase ? "i" : "")
    return subjects.some((subject) => pattern.test(subject))
  } catch {
    return undefined
  }
}

const shown = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}...` : text)

const KILL_PID = "find the PID you mean (`pgrep -fl <pattern>`, `ps`) and `kill <pid>`"

/**
 * The kill rule's verdict on a line, given the processes on the machine and
 * the server's PID: the first kill that would reach OpenCode denies it.
 */
export const killVerdict = (line: string, processes: ReadonlyArray<ProcessInfo>, server: number): Verdict => {
  const opencode = processes.filter((process) => isOpenCode(process, server))
  for (const finding of killFindings(line)) {
    if (finding._tag === "Broadcast")
      return Deny.make({ reason: `\`${finding.command}\` signals every process you own, the OpenCode server among them; ${KILL_PID}` })
    for (const process of opencode) {
      const hit = selects(finding.target, process)
      if (hit === undefined)
        return Deny.make({ reason: `\`${finding.target.command}\` kills by a pattern the guard cannot read, so it may reach the OpenCode server; ${KILL_PID}` })
      if (hit) {
        const what = process.pid === server ? "the OpenCode server this session runs on" : "an OpenCode process (a TUI or another server)"
        return Deny.make({ reason: `\`${finding.target.command}\` would also kill ${what}, pid ${process.pid} (\`${shown(process.args)}\`); ${KILL_PID}` })
      }
    }
  }
  return Allow.make({})
}

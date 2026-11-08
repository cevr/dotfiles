// Which shell commands are heavy: a test run, a typecheck, a build, a gate. A
// heavy command runs at a lower CPU priority and, on Linux, under a memory cap
// (launcher.ts), so one runaway test cannot take the machine down: on
// 2026-11-06 one `bun test` on the workbox grew to 38.5 GB, memory ran out
// and the OpenCode server died with it.
//
// A pattern is a run of words; a simple command of the line is heavy when its
// running words start with them (`bun run gate` matches `bun run gate --all`).
// A pattern's last word also matches a script of that family
// (`bun run test` matches `bun run test:integration`). The launchers in front
// of a command are skipped: package runners (`npx`, `bunx`, `pnpx`,
// `pnpm exec`, `pnpm dlx`, `yarn exec`), `timeout`, `flock`, `setsid`,
// `nohup`, `env`, `nice`, `ionice` and `stdbuf`, with their options and
// `VAR=value` assignments. The script of `sh -c`, `eval`, `flock -c` and
// `env -S` is read, as the guard reads them. `systemd-run` is not read
// through: the unit it starts runs outside the launcher, so the launcher's
// nice and scope would not reach the command.
import { runningWords, SHELLS, shellScript, simpleCommands, type Word } from "./shell-line.ts"

/** The commands heavy by default: test runners, typecheckers, compilers and the gates that run them. */
export const DEFAULT_HEAVY: ReadonlyArray<string> = [
  "bun test",
  "bun run test",
  "bun run gate",
  "bun run check",
  "bun run typecheck",
  "bun run accept",
  "npm test",
  "npm run test",
  "pnpm test",
  "pnpm run test",
  "pnpm typecheck",
  "pnpm run typecheck",
  "yarn test",
  "tsc",
  "tsgo",
  "tsgolint",
  "vitest",
  "jest",
  "playwright test",
  "turbo",
  // Go and Rust compile every package they touch on all cores. `go run` and
  // `cargo run` are left out: what they start is usually a server or a tool
  // that lives on, and their build is mostly cached.
  "go test",
  "go build",
  "go vet",
  "golangci-lint",
  "cargo test",
  "cargo build",
  "cargo check",
  "cargo clippy",
  "cargo nextest",
  "cargo bench",
]

/**
 * A launcher's options: those that take the next word as their value
 * (`--name=value` takes none), and whether its command follows a positional
 * word of its own (`flock <file> <command>`, `timeout <duration> <command>`).
 */
interface Launcher {
  readonly values: ReadonlySet<string>
  readonly positional: number
}

const launcher = (values: ReadonlyArray<string>, positional = 0): Launcher => ({ values: new Set(values), positional })

const LAUNCHERS: ReadonlyMap<string, Launcher> = new Map([
  ["timeout", launcher(["-s", "-k", "--signal", "--kill-after"], 1)],
  ["flock", launcher(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], 1)],
  ["setsid", launcher([])],
  ["nohup", launcher([])],
  ["env", launcher(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["nice", launcher(["-n", "--adjustment"])],
  ["ionice", launcher(["-c", "--class", "-n", "--classdata"])],
  ["stdbuf", launcher(["-i", "--input", "-o", "--output", "-e", "--error"])],
])

/** The options whose value is a command line of its own: `flock -c`, `env -S`. */
const SCRIPT_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["flock", new Set(["-c", "--command"])],
  ["env", new Set(["-S", "--split-string"])],
])

const isAssignment = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)

const base = (word: Word | undefined) => word?.text.split("/").pop()

/** What runs past the launchers in front of it: its words, or a script it hands a shell. */
type Unwrapped = { readonly _tag: "Words"; readonly words: ReadonlyArray<Word> } | { readonly _tag: "Script"; readonly script: string }

const unwrapped = (words: ReadonlyArray<Word>): Unwrapped => {
  const head = base(words[0])
  if (head === undefined) return { _tag: "Words", words }
  if (isAssignment(words[0]?.text ?? "")) return unwrapped(words.slice(1))
  if (head === "npx" || head === "bunx" || head === "pnpx") {
    // Its own flags (`npx -y`, `bunx --bun`) come before the program.
    const at = words.findIndex((word, index) => index > 0 && !word.text.startsWith("-"))
    return unwrapped(at === -1 ? [] : words.slice(at))
  }
  if ((head === "pnpm" || head === "yarn") && (words[1]?.text === "exec" || words[1]?.text === "dlx")) return unwrapped(words.slice(2))
  const options = LAUNCHERS.get(head)
  if (options === undefined) {
    // The shell's own prefixes (`sudo`, `exec`, `time`, `command`): each pass drops at least one word.
    const running = runningWords(words)
    return running.length < words.length ? unwrapped(running) : { _tag: "Words", words }
  }
  let index = 1
  while (index < words.length) {
    const text = words[index]?.text ?? ""
    if (text === "--") {
      index += 1
      break
    }
    if (head === "env" && isAssignment(text)) {
      index += 1
      continue
    }
    // `nice -5`: the adjustment is the option itself.
    if (!text.startsWith("-") || text === "-") break
    if (SCRIPT_OPTIONS.get(head)?.has(text) === true) return { _tag: "Script", script: words[index + 1]?.text ?? "" }
    index += options.values.has(text) ? 2 : 1
  }
  const rest = words.slice(index + options.positional)
  // `flock <file> -c <script>`: the script follows the lock file.
  const script = SCRIPT_OPTIONS.get(head)
  if (options.positional > 0 && script?.has(rest[0]?.text ?? "") === true) return { _tag: "Script", script: rest[1]?.text ?? "" }
  return unwrapped(rest)
}

/** Whether `texts` start with `pattern`'s words, its last word matching a `:`-suffixed script too. */
const startsWith = (texts: ReadonlyArray<string>, pattern: ReadonlyArray<string>): boolean =>
  pattern.length > 0 &&
  pattern.every((word, index) => {
    const text = index === 0 ? texts[0]?.split("/").pop() : texts[index]
    return text === word || (index === pattern.length - 1 && index > 0 && text?.startsWith(`${word}:`) === true)
  })

/** How deep `sh -c`, `eval` and a launcher's script are followed. */
const MAX_DEPTH = 4

/** Whether a command line runs a heavy command: one of its simple commands starts with one of `patterns`. */
export const isHeavy = (line: string, patterns: ReadonlyArray<string>, depth = 0): boolean => {
  const split = patterns.map((pattern) => pattern.split(/\s+/).filter((word) => word !== ""))
  return simpleCommands(line).some((words) => {
    const running = unwrapped(words)
    if (running._tag === "Script") return depth < MAX_DEPTH && isHeavy(running.script, patterns, depth + 1)
    const texts = running.words.map((word) => word.text)
    if (split.some((pattern) => startsWith(texts, pattern))) return true
    if (depth >= MAX_DEPTH) return false
    const head = base(running.words[0])
    const script = head !== undefined && SHELLS.has(head) ? shellScript(running.words.slice(1)) : head === "eval" ? texts.slice(1).join(" ") : undefined
    return script !== undefined && isHeavy(script, patterns, depth + 1)
  })
}

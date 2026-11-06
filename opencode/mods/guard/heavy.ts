// Which shell commands are heavy: a test run, a typecheck, a gate. A heavy
// command runs at a lower CPU priority and, on Linux, under a memory cap
// (launcher.ts), so one runaway test cannot take the machine down: on
// 2026-11-06 one `bun test` on the workbox grew to 38.5 GB, memory ran out
// and the OpenCode server died with it.
//
// A pattern is a run of words; a simple command of the line is heavy when its
// running words start with them (`bun run gate` matches `bun run gate --all`).
// A pattern's last word also matches a script of that family
// (`bun run test` matches `bun run test:integration`). Package runners
// (`npx`, `bunx`, `pnpx`, `pnpm exec`, `pnpm dlx`, `yarn exec`) and `timeout`
// before the command are skipped, and the script of `sh -c` and `eval` is
// read, as the guard reads them.
import { runningWords, SHELLS, shellScript, simpleCommands } from "./shell-line.ts"

/** The commands heavy by default: test runners, typecheckers and the gates that run them. */
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
]

/** `timeout`'s options that take a value. */
const TIMEOUT_VALUE: ReadonlySet<string> = new Set(["-s", "-k", "--signal", "--kill-after"])

/** The words of what runs, past the package runners and `timeout` in front of it. */
const unwrapped = (texts: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = texts[0]?.split("/").pop()
  if (head === "npx" || head === "bunx" || head === "pnpx") {
    // Its own flags (`npx -y`, `bunx --bun`) come before the program.
    const at = texts.findIndex((text, index) => index > 0 && !text.startsWith("-"))
    return at === -1 ? [] : unwrapped(texts.slice(at))
  }
  if ((head === "pnpm" || head === "yarn") && (texts[1] === "exec" || texts[1] === "dlx")) return unwrapped(texts.slice(2))
  if (head === "timeout") {
    let index = 1
    while (index < texts.length && (texts[index] ?? "").startsWith("-")) index += TIMEOUT_VALUE.has(texts[index] ?? "") ? 2 : 1
    return unwrapped(texts.slice(index + 1))
  }
  return texts
}

/** Whether `texts` start with `pattern`'s words, its last word matching a `:`-suffixed script too. */
const startsWith = (texts: ReadonlyArray<string>, pattern: ReadonlyArray<string>): boolean =>
  pattern.length > 0 &&
  pattern.every((word, index) => {
    const text = index === 0 ? texts[0]?.split("/").pop() : texts[index]
    return text === word || (index === pattern.length - 1 && index > 0 && text?.startsWith(`${word}:`) === true)
  })

/** How deep `sh -c` and `eval` are followed. */
const MAX_DEPTH = 4

/** Whether a command line runs a heavy command: one of its simple commands starts with one of `patterns`. */
export const isHeavy = (line: string, patterns: ReadonlyArray<string>, depth = 0): boolean => {
  const split = patterns.map((pattern) => pattern.split(/\s+/).filter((word) => word !== ""))
  return simpleCommands(line).some((words) => {
    const running = runningWords(words)
    const texts = unwrapped(running.map((word) => word.text))
    if (split.some((pattern) => startsWith(texts, pattern))) return true
    if (depth >= MAX_DEPTH) return false
    const head = running[0]?.text.split("/").pop()
    const script = head !== undefined && SHELLS.has(head) ? shellScript(running.slice(1)) : head === "eval" ? texts.slice(1).join(" ") : undefined
    return script !== undefined && isHeavy(script, patterns, depth + 1)
  })
}

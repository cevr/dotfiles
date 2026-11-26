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
import { executable, parseShell, type CommandLine } from "./command-line.ts"

/** The commands heavy by default: test runners, typecheckers, compilers and the gates that run them. */
export const DEFAULT_HEAVY: ReadonlyArray<string> = [
  "bun test",
  "bun run test",
  "bun run gate",
  "bun run check",
  "bun run typecheck",
  "bun run accept",
  "bun scripts/gate.ts",
  "bun scripts/merge-check.ts",
  "bun scripts/fork-checks.ts",
  "bun scripts/receipt.ts",
  "bun scripts/accept.ts",
  "bun scripts/post-land.ts",
  "bun scripts/typecheck.ts",
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
  // A disk survey walks a whole tree for minutes (perf-load H5 caught two at
  // nice 0 on the workbox, 5 to 8 minutes each).
  "du",
  "dtruss",
  "strace",
  "fs_usage",
  "limactl start",
  "limactl shell",
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

/** Whether `texts` start with `pattern`'s words, its last word matching a `:`-suffixed script too. */
const startsWith = (texts: ReadonlyArray<string>, pattern: ReadonlyArray<string>): boolean =>
  pattern.length > 0 &&
  pattern.every((word, index) => {
    if (index === 0) return executable(texts[0] ?? "") === word
    const text = texts[index]
    return text === word || (index === pattern.length - 1 && index > 0 && text?.startsWith(`${word}:`) === true)
  })

/** Classification can use known leaves of a compound command even if the
 * compound command is not a CPU bound. It never guesses an unknown utility. */
export const matchesCommand = (line: CommandLine, patterns: ReadonlyArray<string>) =>
  patterns.some((pattern) => line.runs.some(({ argv }) => startsWith(argv, pattern.split(/\s+/u).filter(Boolean))))

/** `host-admit check run …` (or `bun …/host-admit.ts check run …`): a run that
 * asks admission itself, with its own declared width. */
export const admitsItself = (argv: ReadonlyArray<string>): boolean => {
  const rest = argv.slice(Number(executable(argv[0] ?? "") === "bun"))
  const tool = executable(rest[0] ?? "").replace(/\.ts$/u, "")
  return tool === "host-admit" && rest[1] === "check" && rest[2] === "run"
}

/** Heavy: a run of the line matches a pattern, or the line cannot be resolved.
 * A run that is itself `host-admit check run` is already admitted at the
 * width it declares; wrapping the line again would charge it twice, the
 * outer lease at unknown width (the whole pool) holding the inner one. */
export const heavyCommand = (line: CommandLine, patterns: ReadonlyArray<string>): boolean => {
  if (line.kind === "opaque" && line.unresolved) return patterns.some((pattern) => pattern.trim().length > 0)
  return matchesCommand({ ...line, runs: line.runs.filter(({ argv }) => !admitsItself(argv)) }, patterns)
}

/** Entry for callers that only need classification. */
export const isHeavy = (line: string, patterns: ReadonlyArray<string>) => heavyCommand(parseShell(line), patterns)

// The orchestrate runs of a repository and the orchestrate skill's status
// script. The runs live in `tmp/orchestrate/<run>` at the repository's main
// checkout (a worktree's common git dir points there), and in each directory
// the checkout's `git config --get-all orchestrate.dir` names (a run that
// keeps its unit dirs elsewhere, one run each). The script prints one table
// per run, derived from its units' files and the repository's git
// (`--repo <main checkout>`).
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { env } from "bun"
import { Effect, Layer, Option } from "effect"
import type { RunTable } from "../run-table.ts"
import { RunTables, RunsUnreadable } from "../service.ts"

/** How long one command may run. */
const TIMEOUT_MS = 20_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isNotFound = (cause: unknown) => isRecord(cause) && cause.code === "ENOENT"

/**
 * The environment every command runs in. The host's binary (`process.execPath`
 * inside OpenCode) is Bun underneath: BUN_BE_BUN runs the status script as Bun,
 * where without it the binary reads the script's path as an OpenCode command,
 * shows its help and logs an ERROR on every poll.
 */
const ENV = { ...env, BUN_BE_BUN: "1" }

/** A command's exit code and output. */
const ran = Effect.fn("RunTables.ran")(function* (argv: ReadonlyArray<string>, cwd?: string) {
  const [out, err, code] = yield* Effect.tryPromise({
    try: () => {
      const run = Bun.spawn([...argv], { cwd, env: ENV, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(TIMEOUT_MS) })
      return Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    },
    catch: (cause) => new RunsUnreadable({ message: `${argv[0]} failed: ${messageOf(cause)}` }),
  })
  return { out, err, code }
})

/** A command's output; a command that exits non-zero fails with its stderr. */
const command = Effect.fn("RunTables.command")(function* (argv: ReadonlyArray<string>, cwd?: string) {
  const { out, err, code } = yield* ran(argv, cwd)
  if (code !== 0) return yield* new RunsUnreadable({ message: `${argv[0]} failed: ${err.trim()}` })
  return out
})

/** The directories `orchestrate.dir` names in the checkout at `top`, each as it exists; none when unset. */
const namedDirs = Effect.fn("RunTables.namedDirs")(function* (top: string) {
  const { out, code } = yield* ran(["git", "-C", top, "config", "--get-all", "orchestrate.dir"])
  if (code !== 0) return []
  const named = out.split("\n").flatMap((line) => Option.toArray(Option.map(Option.liftPredicate(line.trim(), (dir) => dir !== ""), (dir) => resolve(top, dir))))
  const found = yield* Effect.forEach(named, (dir) => Effect.promise(() => stat(dir).then((info) => info.isDirectory(), () => false)), { concurrency: 4 })
  return named.filter((_, index) => found[index] === true)
})

/** The runs `script` (the orchestrate skill's `scripts/status.ts`) reads, run by `runtime` (the host's binary). */
export const layer = (script: string, runtime: string = process.execPath) =>
  Layer.succeed(RunTables, {
    list: Effect.fn("RunTables.list")(function* (directory: string) {
      const common = yield* command(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], directory).pipe(Effect.option)
      if (Option.isNone(common)) return []
      const top = basename(common.value.trim()) === ".git" ? dirname(common.value.trim()) : directory
      const root = join(top, "tmp/orchestrate")
      const entries = yield* Effect.tryPromise({ try: () => readdir(root, { withFileTypes: true }), catch: (cause) => cause }).pipe(
        Effect.catch((cause) =>
          isNotFound(cause) ? Effect.succeed([]) : Effect.fail(new RunsUnreadable({ message: messageOf(cause) })),
        ),
      )
      const inRepo = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, dir: join(root, entry.name) }))
      const named = (yield* namedDirs(top).pipe(Effect.orElseSucceed(() => []))).map((dir) => ({ name: basename(dir), dir }))
      const runs = [...inRepo, ...named.filter((run) => !inRepo.some((each) => each.dir === run.dir))]
      return yield* Effect.forEach(
        runs,
        (run) => command([runtime, script, run.dir, "--repo", top]).pipe(Effect.map((table): RunTable => ({ ...run, table }))),
        { concurrency: "unbounded" },
      )
    }),
  })

// The orchestrate runs of a repository and the orchestrate skill's status
// script. The runs live in `tmp/orchestrate/<run>` at the repository's main
// checkout (a worktree's common git dir points there); the script prints one
// table per run, derived from its units' log.md transitions.
import { readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import type { RunTable } from "../run-table.ts"
import { RunTables, RunsUnreadable } from "../service.ts"

/** How long one command may run. */
const TIMEOUT_MS = 20_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isNotFound = (cause: unknown) => isRecord(cause) && cause.code === "ENOENT"

/** A command's output; a command that exits non-zero fails with its stderr. */
const command = Effect.fn("RunTables.command")(function* (argv: ReadonlyArray<string>, cwd?: string) {
  const [out, err, code] = yield* Effect.tryPromise({
    try: () => {
      const run = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(TIMEOUT_MS) })
      return Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    },
    catch: (cause) => new RunsUnreadable({ message: `${argv[0]} failed: ${messageOf(cause)}` }),
  })
  if (code !== 0) return yield* new RunsUnreadable({ message: `${argv[0]} failed: ${err.trim()}` })
  return out
})

/** The runs `script` (the orchestrate skill's `scripts/status.ts`) reads. */
export const layer = (script: string) =>
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
      return yield* Effect.forEach(
        entries.filter((entry) => entry.isDirectory()),
        (entry) =>
          command([process.execPath, script, join(root, entry.name)]).pipe(
            Effect.map((table): RunTable => ({ name: entry.name, dir: join(root, entry.name), table })),
          ),
        { concurrency: "unbounded" },
      )
    }),
  })

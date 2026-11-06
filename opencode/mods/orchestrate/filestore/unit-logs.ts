// The units' logs on disk: a unit dir is found among the paths a prompt or a
// hand-back named, else under the checkout's `tmp/orchestrate/<run>/`, and a
// move is written by the orchestrate skill's log.ts (`--current`), the logs'
// one writer, which keeps their format and refuses a move the machine does not
// allow. Whatever log.ts says, the call goes on.
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { UnitLogs } from "../service.ts"
import type { Transition } from "../unit-log.ts"

/** log.ts has this long to write a line. */
const TIMEOUT_MS = 10_000

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The units' logs, written by `script` (the skill's log.ts). `home` is where
 * a `~/` path points. The host's binary is Bun underneath, so BUN_BE_BUN runs
 * the script as Bun.
 */
export const layer = (script: string, home: string = homedir()) =>
  Layer.succeed(UnitLogs, {
    find: Effect.fn("UnitLogs.find")(function* ({ unit, named, directory }: { readonly unit: string; readonly named: ReadonlyArray<string>; readonly directory?: string }) {
      return yield* Effect.sync(() => {
        for (const path of named) {
          const at = path.startsWith("~/") ? join(home, path.slice(2)) : isAbsolute(path) ? path : directory === undefined ? undefined : resolve(directory, path)
          if (at !== undefined && isDirectory(at)) return at
        }
        if (directory === undefined) return undefined
        const runs = join(directory, "tmp", "orchestrate")
        if (!existsSync(runs)) return undefined
        const found = readdirSync(runs)
          .map((run) => join(runs, run, unit))
          .filter(isDirectory)
        return found.length === 1 ? found[0] : undefined
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    }),
    append: Effect.fn("UnitLogs.append")(function* (unitDir: string, transition: Transition) {
      yield* Effect.tryPromise(async () => {
        const child = Bun.spawn(
          [process.execPath, script, "--current", unitDir, transition.to, `r${transition.round}`, ...(transition.note === "" ? [] : [transition.note])],
          { env: { ...process.env, BUN_BE_BUN: "1" }, stdout: "ignore", stderr: "ignore", timeout: TIMEOUT_MS },
        )
        await child.exited
      }).pipe(Effect.ignore)
    }),
  })

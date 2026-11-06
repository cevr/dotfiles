// The units' logs on disk: a unit dir (one holding spec.md or log.md, or in a
// run dir holding plan.md) is found among the paths a prompt or a hand-back
// named, else under the checkout's `tmp/orchestrate/<run>/`, and a
// move is written by the orchestrate skill's log.ts (`--current`), the logs'
// one writer, which keeps their format and refuses a move the machine does not
// allow. Whatever log.ts says, the call goes on.
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
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
 * A unit dir, as the skill lays it out: it holds the unit's spec.md or log.md,
 * or its run dir holds the run's plan.md. Another directory that only shares
 * the unit's name (a Rift or a checkout called like it) is not one.
 */
const isUnitDir = (path: string) =>
  isDirectory(path) && (existsSync(join(path, "spec.md")) || existsSync(join(path, "log.md")) || existsSync(join(dirname(path), "plan.md")))

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
          if (at !== undefined && isUnitDir(at)) return at
        }
        if (directory === undefined) return undefined
        const runs = join(directory, "tmp", "orchestrate")
        if (!existsSync(runs)) return undefined
        const found = readdirSync(runs)
          .map((run) => join(runs, run, unit))
          .filter(isUnitDir)
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

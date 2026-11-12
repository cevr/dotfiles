// The units' logs on disk: a unit dir (one holding spec.md or log.md, or in a
// run dir holding plan.md) is found among the paths a prompt or a hand-back
// named, else under the checkout's `tmp/orchestrate/<run>/`, and a
// move is written by the orchestrate skill's log.ts (`--current`), the logs'
// one writer, which keeps their format and refuses a move the machine does not
// allow. Whatever log.ts says, the call goes on.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Option } from "effect"
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
export const make = (script: string, home: string = homedir()) =>
  UnitLogs.of({
    find: Effect.fn("UnitLogs.find")(function* ({ unit, named, directory }: { readonly unit: string; readonly named: ReadonlyArray<string>; readonly directory?: string }) {
      return yield* Effect.sync(() => {
        for (const path of named) {
          const at = pointed(home, path, Option.fromNullishOr(directory))
          if (Option.isSome(at) && isUnitDir(at.value)) return at.value
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
    droppedIn: Effect.fn("UnitLogs.droppedIn")(function* (path: string, directory: Option.Option<string>) {
      return yield* Effect.sync(() =>
        Option.filter(pointed(home, path, directory), (dir) => DROPPED.test(lastLine(readFileSync(join(dir, "log.md"), "utf8")))).pipe(Option.map((dir) => basename(dir.replace(/\/+$/, "")))),
      ).pipe(Effect.catchCause(() => Effect.succeed(Option.none<string>())))
    }),
  })

/** The units' logs as a layer (see `make`). */
export const layer = (script: string, home: string = homedir()) => Layer.succeed(UnitLogs, make(script, home))

/** Where `path` points: a `~/` one under `home`, an absolute one as it is, a relative one from `directory` (none without one). */
const pointed = (home: string, path: string, directory: Option.Option<string>): Option.Option<string> =>
  Option.liftPredicate(path, (named: string) => named.startsWith("~/")).pipe(
    Option.map((named) => join(home, named.slice(2))),
    Option.orElse(() => Option.liftPredicate(path, isAbsolute)),
    Option.orElse(() => Option.map(directory, (dir) => resolve(dir, path))),
  )

/** A log.md line that moves its unit to `dropped`: `<time>Z <from> → dropped r<N> …`, as log.ts writes it. */
const DROPPED = / → dropped r\d+(?:\s|$)/

/** A log's last line that is not blank. */
const lastLine = (log: string) => log.split("\n").findLast((line) => line.trim() !== "") ?? ""

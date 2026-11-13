// The units' logs on disk: a unit dir (one holding spec.md or log.md, or in a
// run dir holding plan.md) is found among the paths a prompt or a hand-back
// named, else under the checkout's `tmp/orchestrate/<run>/`, and a
// move is written by the orchestrate skill's log.ts (`--current`), the logs'
// one writer, which keeps their format and refuses a move the machine does not
// allow. Whatever log.ts says, the call goes on. The drops a root logged are
// read from the journal log.ts keeps of them, each checked against its log.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { type LoggedDrop, UnitLogs } from "../service.ts"
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

/** Where the units' logs read: `home`, where a `~/` path points; `journal`, the drops journal log.ts writes. */
export interface Options {
  readonly home?: string
  readonly journal?: string
}

/**
 * The units' logs, written by `script` (the skill's log.ts). The host's binary
 * is Bun underneath, so BUN_BE_BUN runs the script as Bun.
 */
export const make = (script: string, { home = TuiDirs.dirs().home, journal = DROPS_JOURNAL }: Options = {}) =>
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
    drops: Effect.fn("UnitLogs.drops")(function* (session: string) {
      return yield* Effect.sync(() => {
        if (!existsSync(journal)) return []
        const dirs = new Set(readFileSync(journal, "utf8").split("\n").flatMap((line) => Option.toArray(Option.filter(decodeEntry(line), (entry) => entry.session === session))).map((entry) => entry.dir.replace(/\/+$/, "")))
        return [...dirs].flatMap((dir) => Option.toArray(droppedAt(dir)))
      }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<LoggedDrop>>([])))
    }),
  })

/** The units' logs as a layer (see `make`). */
export const layer = (script: string, options: Options = {}) => Layer.succeed(UnitLogs, make(script, options))

/** Where log.ts journals each written drop when `ORCHESTRATE_DROPS` names no other file (log.ts `journalDrop`). */
export const DROPS_JOURNAL = join(TuiDirs.dirs().home, ".cache", "orchestrate", "drops.jsonl")

/** One line of the drops journal: the session whose shell ran log.ts, and the unit dir it resolved. */
const JournalEntry = Schema.fromJsonString(Schema.Struct({ session: Schema.String, dir: Schema.String }))
const decodeEntry = Schema.decodeUnknownOption(JournalEntry)

/** The unit in `dir` when its log.md's last line moves it to `dropped`: only that line counts, a revived unit's older drop does not. */
const droppedAt = (dir: string): Option.Option<LoggedDrop> => {
  const log = join(dir, "log.md")
  if (!existsSync(log)) return Option.none()
  return Option.fromNullishOr(DROPPED.exec(lastLine(readFileSync(log, "utf8")))).pipe(Option.map((match) => ({ unit: basename(dir.replace(/\/+$/, "")), round: Number(match[1]) })))
}

/** Where `path` points: a `~/` one under `home`, an absolute one as it is, a relative one from `directory` (none without one). */
const pointed = (home: string, path: string, directory: Option.Option<string>): Option.Option<string> =>
  Option.liftPredicate(path, (named: string) => named.startsWith("~/")).pipe(
    Option.map((named) => join(home, named.slice(2))),
    Option.orElse(() => Option.liftPredicate(path, isAbsolute)),
    Option.orElse(() => Option.map(directory, (dir) => resolve(dir, path))),
  )

/** A log.md line that moves its unit to `dropped`: `<time>Z <from> → dropped r<N> …`, as log.ts writes it. */
const DROPPED = / → dropped r(\d+)(?:\s|$)/

/** A log's last line that is not blank. */
const lastLine = (log: string) => log.split("\n").findLast((line) => line.trim() !== "") ?? ""

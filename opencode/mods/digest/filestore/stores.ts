// The old stores of a frozen day, read from a folder in the shape `freeze.ts` writes: `runs.json` (each run's id,
// host and root session), and per run `queue.json`, `inbox.jsonl`, `children.jsonl` and `units/<dir>/` (its files
// and their `mtimes.json`), and an `update-<host>.log` per host. Read synchronously: the backfill is a one-shot
// read of a day, its caller a script or a test. A missing file reads as empty; nothing here writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Option, Schema } from "effect"
import type { RunStores, Stores, UnitDir } from "../backfill.ts"

const RunEntry = Schema.Struct({ id: Schema.String, host: Schema.String, session: Schema.String, repo: Schema.optional(Schema.String) })
const decodeRuns = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RunEntry)))
const decodeTimes = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite)))

const textAt = (path: string): string => {
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

const listAt = (path: string): ReadonlyArray<string> => {
  if (!existsSync(path)) return []
  return readdirSync(path).toSorted()
}

const isDir = (path: string): boolean => statSync(path).isDirectory()

const unitDirOf = (dir: string, name: string): UnitDir => {
  const times: Readonly<Record<string, number>> = Option.getOrElse(decodeTimes(textAt(join(dir, "mtimes.json"))), () => ({}))
  return {
    name,
    files: listAt(dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => ({ name: file, text: textAt(join(dir, file)), mtime: Option.getOrElse(Option.fromUndefinedOr(times[file]), () => statSync(join(dir, file)).mtimeMs) })),
  }
}

/** The stores of a frozen day at `dir`. */
export const readStores = (dir: string): Stores => {
  const runs = Option.getOrElse(decodeRuns(textAt(join(dir, "runs.json"))), () => [])
  return {
    runs: runs.map((run): RunStores => {
      const at = join(dir, run.id)
      const units = join(at, "units")
      return {
        id: run.id,
        host: run.host,
        session: run.session,
        repo: Option.fromUndefinedOr(run.repo),
        queue: Option.liftPredicate(textAt(join(at, "queue.json")), (text) => text !== ""),
        inbox: textAt(join(at, "inbox.jsonl")),
        children: textAt(join(at, "children.jsonl")),
        units: listAt(units)
          .filter((name) => isDir(join(units, name)))
          .map((name) => unitDirOf(join(units, name), name)),
      }
    }),
    updates: listAt(dir).flatMap((file) =>
      Option.toArray(Option.map(Option.fromNullishOr(/^update-(.+)\.log$/.exec(file)), (found) => ({ host: found[1] ?? file, text: textAt(join(dir, file)) }))),
    ),
  }
}

// The ledger as a JSONL file (default `~/.cache/orchestrate/machine.jsonl`),
// one line per event, refusal or checkpoint (ledger.ts). The file is read
// afresh at each decision, so every plugin copy of this process sees every
// line, and it stays small: a compaction writes the kept lines to a file
// beside it and renames that over it. A cut last line (a crash mid-write) is
// skipped, and the next line starts on a line of its own. A line that cannot
// be written is dropped, and a restart loses it.
//
// One process writes the file: the OpenCode server on its host. Two servers
// on one file would each compact what they read and could drop the other's
// newest lines.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { DEFAULT_RETENTION, type Line, make, type Retention } from "../ledger.ts"
import type { Cadence } from "../machine.ts"
import { Ledger } from "../service.ts"

/** Every line of `text` that parses, in order. */
export const linesIn = (text: string): ReadonlyArray<unknown> =>
  text.split("\n").flatMap((raw) => {
    if (raw.trim() === "") return []
    try {
      return [JSON.parse(raw) as unknown]
    } catch {
      return []
    }
  })

/** Whether the file's last line has no newline: a cut line. Only its last byte is read. */
const endsCut = (file: string): boolean => {
  if (!existsSync(file)) return false
  const size = statSync(file).size
  if (size === 0) return false
  const fd = openSync(file, "r")
  try {
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

export const layer = (file: string, cadence: Cadence, retention: Retention = DEFAULT_RETENTION) =>
  Layer.effect(
    Ledger,
    make(
      {
        key: resolve(file),
        read: () =>
          Effect.sync(() => {
            try {
              return linesIn(readFileSync(file, "utf8"))
            } catch {
              return []
            }
          }),
        append: (line: Line) =>
          Effect.sync(() => {
            try {
              mkdirSync(dirname(file), { recursive: true })
              // A cut last line gets its newline first, so this line reads.
              appendFileSync(file, `${endsCut(file) ? "\n" : ""}${JSON.stringify(line)}\n`)
            } catch {
              // Dropped: see the header.
            }
          }),
        replace: (lines) =>
          Effect.sync(() => {
            try {
              const next = `${file}.compact-${process.pid}`
              writeFileSync(next, lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
              renameSync(next, file)
            } catch {
              // Kept as it was: the next decision past the threshold tries again.
            }
          }),
        size: () =>
          Effect.sync(() => {
            try {
              return statSync(file).size
            } catch {
              return 0
            }
          }),
      },
      cadence,
      retention,
    ),
  )

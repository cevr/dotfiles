// The ledger as a JSONL file (default `~/.cache/orchestrate/machine.jsonl`),
// one line per event or refusal (ledger.ts). A root's lines are read once,
// when it is first decided, and kept. A cut last line (a crash mid-write) is
// skipped, and the next line starts on a line of its own. A line that cannot
// be written is dropped: the state in memory holds, and a restart loses it.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import { make, type Line } from "../ledger.ts"
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

const isOf = (sessionID: string) => (line: unknown) => typeof line === "object" && line !== null && (line as { sessionID?: unknown }).sessionID === sessionID

export const layer = (file: string, cadence: Cadence) =>
  Layer.effect(
    Ledger,
    make(
      {
        read: (sessionID) =>
          Effect.sync(() => {
            try {
              return linesIn(readFileSync(file, "utf8")).filter(isOf(sessionID))
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
      },
      cadence,
    ),
  )

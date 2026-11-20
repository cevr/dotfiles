// The digest's log in memory, for the seam tests and the simulations: the lines in the order written. It keeps the
// file log's one law, a line in is a line out, and never touches a disk. `writer` is a writer's `DigestLog` straight
// onto it (no relay), so a writer's test reads the very lines it appended.
import { Effect, Layer, Ref } from "effect"
import { DigestLog, encodeLine } from "../event.ts"
import { DigestLines } from "../service.ts"

/** The lines a memory log holds, for a test to read. */
export interface MemoryLines {
  readonly lines: Ref.Ref<ReadonlyArray<string>>
}

export const empty = (): MemoryLines => ({ lines: Ref.makeUnsafe<ReadonlyArray<string>>([]) })

export const make = (memory: MemoryLines) =>
  DigestLines.of({
    append: (line) => Ref.update(memory.lines, (lines) => [...lines, line]),
    read: Effect.map(Ref.get(memory.lines), (lines) => lines.join("\n")),
  })

export const layer = (memory: MemoryLines = empty()) => Layer.succeed(DigestLines, make(memory))

/** A writer's log appending each event's line to `memory`. */
export const writer = (memory: MemoryLines = empty()) =>
  Layer.succeed(DigestLog, DigestLog.of({ append: (event) => Ref.update(memory.lines, (lines) => [...lines, encodeLine(event)]) }))

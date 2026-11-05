// Entries and notices held in memory, and ids whose stored entry no longer
// reads. The model's tests and the plugin's seam test use it.
import { Effect, Layer } from "effect"
import { WakeStore } from "../service.ts"
import type { Entry, Notice } from "../wake.ts"

export interface MemoryWakes {
  readonly entries: Map<string, Entry>
  readonly notices: Map<string, Notice>
  /** Ids stored in a shape that no longer reads. */
  readonly broken: Set<string>
}

export const empty = (): MemoryWakes => ({ entries: new Map(), notices: new Map(), broken: new Set() })

export const layer = (memory: MemoryWakes) =>
  Layer.succeed(WakeStore, {
    entries: Effect.sync(() => [...memory.entries.values()]),
    ids: Effect.sync(() => [...new Set([...memory.entries.keys(), ...memory.broken])]),
    read: (id) => Effect.sync(() => memory.entries.get(id)),
    write: (entry) =>
      Effect.sync(() => {
        memory.broken.delete(entry.id)
        memory.entries.set(entry.id, entry)
      }),
    remove: (id) =>
      Effect.sync(() => {
        memory.broken.delete(id)
        memory.entries.delete(id)
      }),
    notices: Effect.sync(() => [...memory.notices.values()]),
    writeNotice: (notice) => Effect.sync(() => void memory.notices.set(notice.delivery, notice)),
    removeNotice: (delivery) => Effect.sync(() => void memory.notices.delete(delivery)),
  })

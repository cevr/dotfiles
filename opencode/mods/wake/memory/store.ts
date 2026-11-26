// Entries, notices and the registry's handles held in memory, and ids whose
// stored entry no longer reads. The model's tests and the plugin's seam test use it.
import { Effect, Layer } from "effect"
import type { Handle } from "../handle.ts"
import { WakeStore } from "../service.ts"
import type { Entry, Notice } from "../wake.ts"

export interface MemoryWakes {
  readonly entries: Map<string, Entry>
  readonly notices: Map<string, Notice>
  /** Ids stored in a shape that no longer reads. */
  readonly broken: Set<string>
  /** The registry's handles by id. A world kept before the registry has none, and gets its own map at its first layer. */
  readonly handles?: Map<string, Handle>
  /** The last epoch of each `<server>/<location>`; a world kept before the registry has none, as `handles`. */
  readonly epochs?: Map<string, number>
}

export const empty = (): MemoryWakes => ({ entries: new Map(), notices: new Map(), broken: new Set(), handles: new Map(), epochs: new Map() })

export const layer = (memory: MemoryWakes) => {
  const handles = memory.handles ?? new Map<string, Handle>()
  const epochs = memory.epochs ?? new Map<string, number>()
  return Layer.succeed(WakeStore, {
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
    handles: Effect.sync(() => [...handles.values()]),
    writeHandle: (handle) => Effect.sync(() => void handles.set(handle.id, handle)),
    removeHandle: (id) => Effect.sync(() => void handles.delete(id)),
    nextEpoch: (server, location) =>
      Effect.sync(() => {
        const key = `${server}/${location}`
        const next = (epochs.get(key) ?? 0) + 1
        epochs.set(key, next)
        return next
      }),
  })
}

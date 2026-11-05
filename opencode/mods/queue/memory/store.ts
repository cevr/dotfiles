// Queues held in memory: each session's snapshot, or why it cannot be read.
// The plugin's seam test uses it.
import { Effect, Layer } from "effect"
import { EMPTY, type Snapshot } from "../queue.ts"
import { QueueStore, QueueUnreadable } from "../service.ts"

/** The store's contents: each session's queue, and the sessions whose queue reads as broken (with why). */
export interface MemoryQueues {
  readonly queues: Map<string, Snapshot>
  readonly broken: Map<string, string>
}

export const empty = (): MemoryQueues => ({ queues: new Map(), broken: new Map() })

export const layer = (memory: MemoryQueues) =>
  Layer.succeed(QueueStore, {
    read: (sessionID) =>
      Effect.suspend(() => {
        const broken = memory.broken.get(sessionID)
        return broken === undefined ? Effect.succeed(memory.queues.get(sessionID) ?? EMPTY) : Effect.fail(new QueueUnreadable({ message: broken }))
      }),
    write: (sessionID, snapshot) =>
      Effect.sync(() => {
        memory.broken.delete(sessionID)
        memory.queues.set(sessionID, snapshot)
      }),
    remove: (sessionID) =>
      Effect.sync(() => {
        memory.broken.delete(sessionID)
        memory.queues.delete(sessionID)
      }),
  })

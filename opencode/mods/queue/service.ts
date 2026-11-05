// The contract the queue needs from outside: somewhere to keep each session's
// queue. What every implementation owes is in laws.ts.
import { Context, type Effect, Schema } from "effect"
import type { Snapshot } from "./queue.ts"

/** A session's stored queue exists but could not be read. */
export class QueueUnreadable extends Schema.TaggedError<QueueUnreadable>()("QueueUnreadable", { message: Schema.String }) {}

/** A session's queue could not be written or removed. */
export class QueueUnwritable extends Schema.TaggedError<QueueUnwritable>()("QueueUnwritable", { message: Schema.String }) {}

/**
 * Each session's queue, keyed by its session id. A session with none reads as
 * `EMPTY`; a write replaces it whole, so a reader sees the old queue or the
 * new one, never a mix; `remove` forgets it, and removing none is no failure.
 */
export class QueueStore extends Context.Service<
  QueueStore,
  {
    readonly read: (sessionID: string) => Effect.Effect<Snapshot, QueueUnreadable>
    readonly write: (sessionID: string, snapshot: Snapshot) => Effect.Effect<void, QueueUnwritable>
    readonly remove: (sessionID: string) => Effect.Effect<void, QueueUnwritable>
  }
>()("dotfiles-opencode/queue/QueueStore") {}

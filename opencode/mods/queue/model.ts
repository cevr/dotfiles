// The queue's handlers: change a session's queue through the Queue aggregate
// and store the list it leads to with the next revision; read it; forget it.
// Changes are serialized, so two calls at once (a cell's Promise.all) each see
// the other's result.
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { commandOf, EMPTY, Queue, type QueueInput, type Rejection, type Snapshot } from "./queue.ts"
import { QueueStore, type QueueUnreadable, type QueueUnwritable } from "./service.ts"

export class QueueModel extends Context.Service<
  QueueModel,
  {
    /** Apply the tool's input to `sessionID`'s queue; the queue as it now stands. */
    readonly change: (sessionID: string, input: QueueInput) => Effect.Effect<Snapshot, Rejection | QueueUnreadable | QueueUnwritable>
    readonly get: (sessionID: string) => Effect.Effect<Snapshot, QueueUnreadable>
    readonly forget: (sessionID: string) => Effect.Effect<void, QueueUnwritable>
  }
>()("dotfiles-opencode/queue/QueueModel") {}

export const layer = Layer.effect(
  QueueModel,
  Effect.gen(function* () {
    const store = yield* QueueStore
    const lock = yield* Semaphore.make(1)
    return {
      change: Effect.fn("QueueModel.change")(function* (sessionID: string, input: QueueInput) {
        const command = yield* commandOf(input)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            // A whole new list needs nothing of the old one but its done stamps, so an unreadable store does not block it.
            const stored = store.read(sessionID)
            const current = yield* (command._tag === "SetQueue" ? stored.pipe(Effect.orElseSucceed(() => EMPTY)) : stored)
            const now = yield* Clock.currentTimeMillis
            const events = yield* Queue.decide({ items: current.items }, command, now)
            if (events.length === 0) return current
            const next = { revision: current.revision + 1, items: fold(Queue, events, { items: current.items }).items }
            yield* store.write(sessionID, next)
            return next
          }),
        )
      }),
      get: (sessionID) => store.read(sessionID),
      forget: (sessionID) => store.remove(sessionID),
    }
  }),
)

// The queue's handlers: change a session's queue through the Queue aggregate
// and store the list it leads to with the next revision; read it; forget it.
// Changes are serialized, so two calls at once (a cell's Promise.all) each see
// the other's result.
import { Array as Arr, Clock, Context, Effect, Layer, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { commandOf, EMPTY, namedOf, Queue, type QueueInput, type Rejection, sameTouches, type Snapshot, touchedOf } from "./queue.ts"
import { QueueStore, type QueueUnreadable, type QueueUnwritable } from "./service.ts"

export class QueueModel extends Context.Service<
  QueueModel,
  {
    /** Apply the tool's input to `sessionID`'s queue; the queue as it now stands. */
    readonly change: (sessionID: string, input: QueueInput) => Effect.Effect<Snapshot, Rejection | QueueUnreadable | QueueUnwritable>
    /** The queue as the RPC answers it: its revision and items, without the touch times. */
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
            const items = fold(Queue, events, { items: current.items }).items
            // A patch that restates an item marks it checked, though the list stays as it was.
            const touched = touchedOf(current, items, namedOf(command), now)
            if (events.length === 0 && sameTouches(current, touched)) return current
            const revision = Arr.match(events, { onEmpty: () => current.revision, onNonEmpty: () => current.revision + 1 })
            const next = { revision, items, touched }
            yield* store.write(sessionID, next)
            return next
          }),
        )
      }),
      get: (sessionID) => store.read(sessionID).pipe(Effect.map(({ revision, items }) => ({ revision, items }))),
      forget: (sessionID) => store.remove(sessionID),
    }
  }),
)

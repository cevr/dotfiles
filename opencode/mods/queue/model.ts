// The queue's handlers: change a session's queue through the Queue aggregate
// and store the list it leads to with the next revision; read it; forget it;
// and send the owner's answer to an item to the session, recording that it
// went. Changes are serialized, so two calls at once (a cell's Promise.all)
// each see the other's result.
import { Array as Arr, Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { letterOf, noticeOf } from "./answer.ts"
import { AnswerItem, type Command, commandOf, EMPTY, namedOf, Queue, type QueueInput, type Rejection, sameTouches, type Snapshot, touchedOf } from "./queue.ts"
import { QueueHost, QueueStore, type NoteRefused, type QueueUnreadable, type QueueUnwritable } from "./service.ts"

export class QueueModel extends Context.Service<
  QueueModel,
  {
    /** Apply the tool's input to `sessionID`'s queue; the queue as it now stands. */
    readonly change: (sessionID: string, input: QueueInput) => Effect.Effect<Snapshot, Rejection | QueueUnreadable | QueueUnwritable>
    /**
     * Send the owner's `answer` to item `id` of `sessionID`'s queue as one
     * message that wakes the session, then record on the item that it went;
     * nothing else of the item changes. An item the queue does not hold, or a
     * blank answer, sends nothing.
     */
    readonly answer: (sessionID: string, id: string, answer: string) => Effect.Effect<Snapshot, Rejection | QueueUnreadable | QueueUnwritable | NoteRefused>
    /** The queue as the RPC answers it: its revision and items, without the touch times. */
    readonly get: (sessionID: string) => Effect.Effect<Snapshot, QueueUnreadable>
    readonly forget: (sessionID: string) => Effect.Effect<void, QueueUnwritable>
  }
>()("dotfiles-opencode/queue/QueueModel") {}

export const layer = Layer.effect(
  QueueModel,
  Effect.gen(function* () {
    const store = yield* QueueStore
    const host = yield* QueueHost
    const lock = yield* Semaphore.make(1)
    /** Decide `command` on the stored queue, run `deliver` with the list it leads to, then store that list. */
    const apply = <E>(sessionID: string, command: Command, deliver: (items: Snapshot["items"]) => Effect.Effect<void, E>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          // A whole new list needs nothing of the old one but its done stamps, so an unreadable store does not block it.
          const stored = store.read(sessionID)
          const current = yield* (command._tag === "SetQueue" ? stored.pipe(Effect.orElseSucceed(() => EMPTY)) : stored)
          const now = yield* Clock.currentTimeMillis
          const events = yield* Queue.decide({ items: current.items }, command, now)
          const items = fold(Queue, events, { items: current.items }).items
          yield* deliver(items)
          // A patch that restates an item marks it checked, though the list stays as it was.
          const touched = touchedOf(current, items, namedOf(command), now)
          if (events.length === 0 && sameTouches(current, touched)) return current
          const revision = Arr.match(events, { onEmpty: () => current.revision, onNonEmpty: () => current.revision + 1 })
          const next = { revision, items, touched }
          yield* store.write(sessionID, next)
          return next
        }),
      )
    return {
      change: Effect.fn("QueueModel.change")(function* (sessionID: string, input: QueueInput) {
        const command = yield* commandOf(input)
        return yield* apply(sessionID, command, () => Effect.void)
      }),
      // The message goes before the record: an answer recorded but never sent would show as answered to nobody.
      answer: Effect.fn("QueueModel.answer")(function* (sessionID: string, id: string, answer: string) {
        // The aggregate refused an unknown item or a blank answer before this runs; the answer is sent as it records it.
        return yield* apply(sessionID, AnswerItem.make({ id, answer }), (items) =>
          Effect.forEach(
            Arr.flatMap(items, (item) =>
              Option.toArray(Option.map(Option.filter(Option.fromNullishOr(item.answered), () => item.id === id), (answered) => ({ item, answer: answered.answer }))),
            ),
            (sent) => host.note(sessionID, letterOf(sent.item, sent.answer), noticeOf(sent.item), true, "answer"),
            { discard: true },
          ),
        )
      }),
      get: (sessionID) => store.read(sessionID).pipe(Effect.map(({ revision, items }) => ({ revision, items }))),
      forget: (sessionID) => store.remove(sessionID),
    }
  }),
)

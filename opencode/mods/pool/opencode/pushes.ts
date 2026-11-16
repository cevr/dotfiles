// The Pushes aggregate's state (push.ts) in the plugin's storage, which
// OpenCode keeps once per host, so every instance of the plugin (one per
// directory) sees the same pushes: one key per push, `push/push/<id>`. A
// push's key goes when it ends: nothing of it outlasts it. An older pool's
// questions under `push/ask/` are never read.
import { Effect, Layer, Option, Schema } from "effect"
import { type Event, Push, type PushState } from "../push.ts"
import { PushStore } from "../service.ts"
import { PAGE, type Storage } from "./ledger.ts"

const PUSHES = "push/push/"

const pushKey = (id: string) => `${PUSHES}${encodeURIComponent(id)}`

const decodePush = Schema.decodeUnknownOption(Push)
// As JSON: a scope's absent keys are typed `never`, which the storage's JSON type does not take as is.
const encodePush = Schema.encodeSync(Schema.toCodecJson(Push))

const EMPTY: PushState = { pushes: {} }

/** Every entry under `prefix`, in key order. */
const scanAll = (storage: Storage, prefix: string) =>
  Effect.gen(function* () {
    const entries: Array<{ readonly key: string; readonly value: unknown }> = []
    let after: string | undefined
    do {
      const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
      entries.push(...page.entries)
      after = page.next
    } while (after !== undefined)
    return entries
  })

export const layer = (storage: Storage) =>
  Layer.succeed(PushStore, {
    // Pushes that cannot be read are none: the pace holds as without a push.
    read: Effect.gen(function* () {
      const pushes: Record<string, Push> = {}
      for (const { value } of yield* scanAll(storage, PUSHES)) {
        const push = Option.getOrUndefined(decodePush(value))
        if (push !== undefined) pushes[push.id] = push
      }
      return { pushes } satisfies PushState
    }).pipe(
      Effect.catchCause(() => Effect.succeed(EMPTY)),
      Effect.withSpan("PushStore.read"),
    ),
    record: Effect.fn("PushStore.record")(function* (events: ReadonlyArray<Event>, _state: PushState) {
      for (const event of events) {
        const write = (() => {
          switch (event._tag) {
            case "PushStarted":
              return storage.set(pushKey(event.push.id), encodePush(event.push))
            case "PushEnded":
              return storage.remove(pushKey(event.id))
          }
        })()
        yield* write.pipe(Effect.ignoreCause)
      }
    }),
  })

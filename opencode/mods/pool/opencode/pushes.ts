// The Pushes aggregate's state (push.ts) in the plugin's storage, which
// OpenCode keeps once per host, so every instance of the plugin (one per
// directory) sees the same pushes: one key per push, `push/push/<id>`, and
// one per scope's question, `push/ask/<scope key, URI-encoded>`. A push's key
// goes when it ends: nothing of it outlasts it.
import { Effect, Layer, Option, Schema } from "effect"
import { type Event, Push, PushAsk, type PushState } from "../push.ts"
import { PushStore } from "../service.ts"
import { PAGE, type Storage } from "./ledger.ts"

const PUSHES = "push/push/"
const ASKS = "push/ask/"

const pushKey = (id: string) => `${PUSHES}${encodeURIComponent(id)}`
const askKey = (key: string) => `${ASKS}${encodeURIComponent(key)}`

const decodePush = Schema.decodeUnknownOption(Push)
const decodeAsk = Schema.decodeUnknownOption(PushAsk)
const encodePush = Schema.encodeSync(Push)
const encodeAsk = Schema.encodeSync(PushAsk)

const EMPTY: PushState = { pushes: {}, asks: {} }

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
      const asks: Record<string, PushAsk> = {}
      for (const { value } of yield* scanAll(storage, ASKS)) {
        const ask = Option.getOrUndefined(decodeAsk(value))
        if (ask !== undefined) asks[ask.key] = ask
      }
      return { pushes, asks } satisfies PushState
    }).pipe(
      Effect.catchCause(() => Effect.succeed(EMPTY)),
      Effect.withSpan("PushStore.read"),
    ),
    record: Effect.fn("PushStore.record")(function* (events: ReadonlyArray<Event>, state: PushState) {
      for (const event of events) {
        const write = (() => {
          switch (event._tag) {
            case "PushStarted":
              return storage.set(pushKey(event.push.id), encodePush(event.push))
            case "PushEnded":
              return storage.remove(pushKey(event.id))
            case "PushAsked":
              return storage.set(askKey(event.ask.key), encodeAsk(event.ask))
            case "PushAnswered": {
              const ask = state.asks[event.key]
              return ask === undefined ? Effect.void : storage.set(askKey(ask.key), encodeAsk(ask))
            }
            case "AsksForgotten":
              return Effect.forEach(event.keys, (key) => storage.remove(askKey(key)), { discard: true })
          }
        })()
        yield* write.pipe(Effect.ignoreCause)
      }
    }),
  })

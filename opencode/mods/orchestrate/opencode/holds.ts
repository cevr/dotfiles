// What the other plugins hold for a root, over their RPCs, each read with
// this mod's own schema: the wakes' `pending` (mods/wake wake.ts `WAKES`:
// alarms, monitors, latches), the questions' `open` (mods/questions
// question.ts `QUESTIONS`) and the queue's `get` (mods/queue queue.ts
// `QUEUE`). A plugin that is not loaded, fails, times out or answers
// something else holds nothing, so a missing plugin never stops a nudge for
// good.
import { Effect, Layer, Option, Schema } from "effect"
import { NO_HOLDS } from "../idle.ts"
import { RootHolds } from "../service.ts"

/** The three RPC methods, as the plugin's client calls them. */
export interface Asks {
  readonly pending: (input: { readonly sessionIDs: ReadonlyArray<string> }) => Effect.Effect<unknown, unknown>
  readonly open: (input: { readonly sessionIDs: ReadonlyArray<string> }) => Effect.Effect<unknown, unknown>
  readonly queue: (input: { readonly sessionID: string }) => Effect.Effect<unknown, unknown>
}

const TIMEOUT = "5 seconds"

const Pending = Schema.Struct({ entries: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const Open = Schema.Struct({ questions: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const Queue = Schema.Struct({ items: Schema.Array(Schema.Struct({ text: Schema.String, state: Schema.String, detail: Schema.optional(Schema.String) })) })

/** One ask's answer through `schema`, or none. */
const read = <A>(ask: Effect.Effect<unknown, unknown>, schema: Schema.Codec<A, unknown, never, never>) =>
  ask.pipe(
    Effect.timeoutOption(TIMEOUT),
    Effect.map((answer) => Option.flatMap(answer, Schema.decodeUnknownOption(schema))),
    Effect.catchCause(() => Effect.succeed(Option.none<A>())),
  )

/** A queue item as a wait or a need names it: its text, and its detail when it has one. */
const named = (item: { readonly text: string; readonly detail?: string | undefined }) => (item.detail === undefined ? item.text : `${item.text} (${item.detail})`)

export const layer = (asks: Asks) =>
  Layer.succeed(RootHolds, {
    of: Effect.fn("RootHolds.of")(function* (sessionID: string) {
      const [pending, open, queue] = yield* Effect.all(
        [
          read(Effect.suspend(() => asks.pending({ sessionIDs: [sessionID] })), Pending),
          read(Effect.suspend(() => asks.open({ sessionIDs: [sessionID] })), Open),
          read(Effect.suspend(() => asks.queue({ sessionID })), Queue),
        ],
        { concurrency: "unbounded" },
      )
      const items = Option.isNone(queue) ? [] : queue.value.items
      return {
        wakes: Option.isNone(pending) ? NO_HOLDS.wakes : pending.value.entries.filter((entry) => entry.sessionID === sessionID).length,
        questions: Option.isNone(open) ? NO_HOLDS.questions : open.value.questions.filter((question) => question.sessionID === sessionID).length,
        needsYou: items.filter((item) => item.state === "needs-you").map(named),
        waits: items.filter((item) => item.state === "waiting").map(named),
      }
    }),
  })

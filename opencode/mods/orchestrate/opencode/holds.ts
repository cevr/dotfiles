// What the other plugins hold for a root, over their RPCs, each read with
// this mod's own schema: the wakes' `pending` (mods/wake wake.ts `WAKES`:
// alarms, monitors, latches) and `jobs`, the questions' `open` (mods/questions
// question.ts `QUESTIONS`) and the queue's `get` (mods/queue queue.ts
// `QUEUE`). A plugin that is not loaded, fails, times out or answers
// something else holds nothing, so a missing plugin never stops a nudge for
// good.
import { Effect, Layer, Option, Schema } from "effect"
import { NO_HOLDS } from "../idle.ts"
import { RootHolds } from "../service.ts"

/** The RPC methods, as the plugin's client calls them. */
export interface Asks {
  readonly pending: (input: { readonly sessionIDs: ReadonlyArray<string> }) => Effect.Effect<unknown, unknown>
  readonly open: (input: { readonly sessionIDs: ReadonlyArray<string> }) => Effect.Effect<unknown, unknown>
  readonly queue: (input: { readonly sessionID: string }) => Effect.Effect<unknown, unknown>
  readonly jobs: (input: { readonly sessionID: string }) => Effect.Effect<unknown, unknown>
}

const TIMEOUT = "5 seconds"

const Pending = Schema.Struct({ entries: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const Open = Schema.Struct({ questions: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const Queue = Schema.Struct({ items: Schema.Array(Schema.Struct({ text: Schema.String, state: Schema.String, detail: Schema.optional(Schema.String) })) })

/** The same answers as the ledger reads them: each entry and item whole. */
const PendingShown = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ sessionID: Schema.String, kind: Schema.String, note: Schema.String, dueAt: Schema.Number })),
})
const QueueShown = Schema.Struct({
  items: Schema.Array(Schema.Struct({ text: Schema.String, state: Schema.String, detail: Schema.OptionFromOptionalKey(Schema.String) })),
})
const Jobs = Schema.Struct({ jobs: Schema.Array(Schema.Struct({ sessionID: Schema.String, note: Schema.String, command: Schema.String, state: Schema.String })) })

/** One ask's answer through `schema`, or none. */
const read = <A>(ask: Effect.Effect<unknown, unknown>, schema: Schema.Codec<A, unknown, never, never>) =>
  ask.pipe(
    Effect.timeoutOption(TIMEOUT),
    Effect.map((answer) => Option.flatMap(answer, Schema.decodeUnknownOption(schema))),
    Effect.catchCause(() => Effect.succeed(Option.none<A>())),
  )

/** A queue item as a wait or a need names it: its text, and its detail when it has one. */
const named = (item: { readonly text: string; readonly detail?: string | undefined }) => (item.detail === undefined ? item.text : `${item.text} (${item.detail})`)

/** A job's states that still run. */
const RUNNING = ["starting", "running"]

/** What an answer lists, or nothing when there was none. */
const listed = <A, B>(answer: Option.Option<A>, rows: (value: A) => ReadonlyArray<B>): ReadonlyArray<B> => Option.match(answer, { onNone: () => [], onSome: rows })

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
    held: Effect.fn("RootHolds.held")(function* (sessionID: string) {
      const [pending, queue, jobs] = yield* Effect.all(
        [
          read(Effect.suspend(() => asks.pending({ sessionIDs: [sessionID] })), PendingShown),
          read(Effect.suspend(() => asks.queue({ sessionID })), QueueShown),
          read(Effect.suspend(() => asks.jobs({ sessionID })), Jobs),
        ],
        { concurrency: "unbounded" },
      )
      return {
        queue: listed(queue, (answer) => answer.items.filter((item) => item.state !== "done")),
        wakes: listed(pending, (answer) => answer.entries.filter((entry) => entry.sessionID === sessionID)).map((entry) => ({ kind: entry.kind, note: entry.note, dueAt: entry.dueAt })),
        jobs: listed(jobs, (answer) => answer.jobs.filter((job) => job.sessionID === sessionID && RUNNING.includes(job.state))).map((job) => ({
          note: job.note || job.command,
          state: job.state,
        })),
      }
    }),
  })

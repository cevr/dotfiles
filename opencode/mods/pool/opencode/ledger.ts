// The pools' ledger in the plugin's storage, one key per hold, reading and
// session cache under the pool's integration id:
// `<pool>/hold/<credentialID>`, `<pool>/reading/<credentialID>` and
// `<pool>/cache/<sessionID>` (where the session last sent a request, and when,
// with its agent's own cache lifetime when it has one and whether the session
// outlived it); and the priced steps in chunks, `chunk/step/<pool>/…`
// (chunks.ts), which every copy of the plugin in a process reads once. A step
// names the assistant message it wrote, once the host names it. A previous
// process may have kept a step per key, `<pool>/step/<at, 15 digits>/<sessionID>`:
// those are read too, and folded into chunks. A ledger from before caches were
// kept has no cache key and restores none.
import { Effect, Layer, Option, Schema } from "effect"
import { cacheMark, type Event, type LedgerState, type PoolId } from "../account-pool.ts"
import { Mark, Step, WINDOW_MS } from "../accounts.ts"
import { QuotaReading } from "../quota.ts"
import { Ledger } from "../service.ts"
import { Hold } from "../status.ts"
import * as Chunks from "./chunks.ts"

/** The plugin's storage, as the plugin provides it. */
export interface Storage {
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{ readonly entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>; readonly next?: string }, unknown>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void, unknown>
  readonly remove: (key: string) => Effect.Effect<void, unknown>
}

/** How many entries one scan of the storage asks for. */
export const PAGE = 500

const holdKey = (credentialID: string) => `hold/${credentialID}`
const readingKey = (credentialID: string) => `reading/${credentialID}`
const cacheKey = (sessionID: string) => `cache/${sessionID}`

/** A step in a chunk: time, session, login, cost, and the message when the host named it. */
const StepRow = Schema.Union([
  Schema.Tuple([Schema.Number, Schema.String, Schema.String, Schema.Number]),
  Schema.Tuple([Schema.Number, Schema.String, Schema.String, Schema.Number, Schema.String]),
])

/** A pool's priced steps as chunks keep them; a step's identity is its old key's: its time and session. */
export const stepKind = (pool: PoolId): Chunks.Kind<Step, typeof StepRow.Type, Step> => ({
  prefix: `chunk/step/${pool}/`,
  legacy: `${pool}/step/`,
  keepMs: WINDOW_MS,
  identity: (step) => `${step.at}/${step.sessionID}`,
  at: (step) => step.at,
  row: StepRow,
  toRow: (step) =>
    Option.match(Option.fromUndefinedOr(step.messageID), {
      onNone: () => [step.at, step.sessionID, step.credentialID, step.cost],
      onSome: (messageID) => [step.at, step.sessionID, step.credentialID, step.cost, messageID],
    }),
  fromRow: ([at, sessionID, credentialID, cost, ...message]) => ({
    at,
    sessionID,
    credentialID,
    cost,
    ...Object.fromEntries(message.map((messageID) => ["messageID", messageID])),
  }),
  old: Step,
  fromOld: (_key, step) => step,
})

/** The steps store of each pool, made by its first use; a process passes its own, shared by every copy (records.ts). */
export type Steps = (pool: PoolId) => Chunks.Store<Step>

type Write =
  | { readonly _tag: "Put"; readonly key: string; readonly value: Schema.Json }
  | { readonly _tag: "Remove"; readonly key: string }
  /** Remove the key only while what it holds still matches: another copy of the plugin may have written it since. */
  | { readonly _tag: "RemoveIf"; readonly key: string; readonly stale: (stored: unknown) => boolean }

const put = (key: string, value: Schema.Json): Write => ({ _tag: "Put", key, value })
const remove = (key: string): Write => ({ _tag: "Remove", key })

/**
 * A cache mark expired as one copy of the plugin saw it. OpenCode runs a copy
 * per location on one storage, and the copy that serves the session may have
 * written a newer mark since: that one stays (a restart reads it back).
 */
const removeExpiredMark = (sessionID: string, at: number): Write => ({
  _tag: "RemoveIf",
  key: cacheKey(sessionID),
  stale: (stored) => Option.match(decodeMark(stored), { onNone: () => true, onSome: (mark) => mark.at <= at }),
})

/** The writes that bring the ledger up to `event`, in order. */
const writesOf = (event: Event): ReadonlyArray<Write> => {
  switch (event._tag) {
    case "ReadingTaken":
      return [
        put(readingKey(event.credentialID), event.reading),
        ...(event.hold === undefined ? [] : [put(holdKey(event.credentialID), event.hold)]),
      ]
    case "RequestRefused":
      return [put(holdKey(event.credentialID), event.hold)]
    case "RequestPlaced":
      return [put(cacheKey(event.sessionID), cacheMark({ credentialID: event.credentialID, at: event.at }, event))]
    case "StepRecorded":
      return [put(cacheKey(event.step.sessionID), cacheMark({ credentialID: event.step.credentialID, at: event.step.at }, event))]
    case "LedgerPruned":
      return [
        ...event.holds.map((credentialID) => remove(holdKey(credentialID))),
        ...event.caches.map((cache) => removeExpiredMark(cache.sessionID, cache.at)),
      ]
    case "HoldCleared":
      return [remove(holdKey(event.credentialID))]
    case "LoginsListed":
    case "RunReleased":
      return []
  }
}

/**
 * What `event` changes of the steps: a recorded step is appended; pruned steps are those out of the window, so
 * every step as old as the newest of them goes.
 */
const stepsWrite = (store: Chunks.Store<Step>, event: Event): Effect.Effect<void> => {
  if (event._tag === "StepRecorded") return store.append(event.step)
  if (event._tag !== "LedgerPruned") return Effect.void
  return Option.match(Option.fromUndefinedOr(event.steps[0]), {
    onNone: () => Effect.void,
    onSome: (first) => store.expire(event.steps.reduce((through, step) => Math.max(through, step.at), first.at)),
  })
}

const decodeHold = Schema.decodeUnknownOption(Hold)
const decodeReading = Schema.decodeUnknownOption(QuotaReading)
const decodeMark = Schema.decodeUnknownOption(Mark)

/** The ledger the entries hold, with `steps`; an entry that does not decode is left out. */
const ledgerOf = (entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>, steps: ReadonlyArray<Step>): LedgerState => {
  const holds: Record<string, Hold> = {}
  const readings: Record<string, QuotaReading> = {}
  const recent: Record<string, Mark> = {}
  for (const { key, value } of entries) {
    const [kind, id] = key.split("/", 2)
    if (id === undefined) continue
    if (kind === "hold") {
      const hold = Option.getOrUndefined(decodeHold(value))
      if (hold !== undefined) holds[id] = hold
    } else if (kind === "reading") {
      const reading = Option.getOrUndefined(decodeReading(value))
      if (reading !== undefined) readings[id] = reading
    } else if (kind === "cache") {
      const mark = Option.getOrUndefined(decodeMark(value))
      if (mark !== undefined) recent[id] = mark
    }
  }
  return { holds, readings, steps: [...steps], recent }
}

/** A steps store per pool, for one layer's own use: a test's, or a host that passes none. */
const ownSteps = (storage: Storage): Steps => {
  const stores = new Map<PoolId, Chunks.Store<Step>>()
  return (pool) =>
    Option.getOrElse(Option.fromNullishOr(stores.get(pool)), () => {
      const made = Chunks.open(storage, stepKind(pool))
      stores.set(pool, made)
      return made
    })
}

/** The holds, readings and caches are small and read by each copy; the steps come from `steps`, one store per process. */
export const layer = (storage: Storage, steps: Steps = ownSteps(storage)) =>
  Layer.succeed(Ledger, {
    // A ledger that cannot be read starts the pool empty.
    restore: Effect.fn("Ledger.restore")(
      function* (pool: PoolId) {
        const entries: Array<{ key: string; value: unknown }> = []
        for (const kind of ["hold/", "reading/", "cache/"]) {
          const prefix = `${pool}/${kind}`
          let after: string | undefined
          do {
            const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
            for (const entry of page.entries) entries.push({ key: entry.key.slice(pool.length + 1), value: entry.value })
            after = page.next
          } while (after !== undefined)
        }
        return ledgerOf(entries, yield* steps(pool).entries)
      },
      Effect.catchCause(() => Effect.succeed(ledgerOf([], []))),
    ),
    // A write that fails is lost: the ledger only speeds the next process up.
    record: Effect.fn("Ledger.record")(function* (pool: PoolId, events: ReadonlyArray<Event>) {
      for (const event of events) yield* stepsWrite(steps(pool), event)
      for (const write of events.flatMap(writesOf)) {
        const key = `${pool}/${write.key}`
        if (write._tag === "Put") yield* storage.set(key, write.value).pipe(Effect.ignoreCause)
        else if (write._tag === "Remove") yield* storage.remove(key).pipe(Effect.ignoreCause)
        else
          yield* storage.scan({ prefix: key, limit: 1 }).pipe(
            Effect.flatMap((page) => {
              const stored = page.entries.find((entry) => entry.key === key)
              return stored === undefined || !write.stale(stored.value) ? Effect.void : storage.remove(key)
            }),
            Effect.ignoreCause,
          )
      }
    }),
  })

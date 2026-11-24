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
import { Clock, Effect, Layer, Option, Predicate, Schema, Semaphore } from "effect"
import { cacheMark, type Event, type LedgerState, type PoolId } from "../account-pool.ts"
import { Mark, Step, WINDOW_MS } from "../accounts.ts"
import { HOLD_STORE_RETRY_MS } from "../handoff.ts"
import { QuotaReading } from "../quota.ts"
import { HoldStoreUnavailable, Ledger } from "../service.ts"
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

/** A failed hold write fences a send until the store has accepted it. */
type PendingHold = {
  readonly credentialID: string
  readonly retryAt: number
  readonly next: Option.Option<Hold>
  readonly merge: boolean
}
const authorityKey = Symbol.for("dotfiles-opencode.pool.hold-authority.v1")
interface HoldAuthority {
  readonly [authorityKey]: true
  readonly lock: Semaphore.Semaphore
  readonly pending: Map<string, PendingHold>
}
export const holdAuthority = (): HoldAuthority => ({
  [authorityKey]: true,
  lock: Semaphore.makeUnsafe(1),
  pending: new Map<string, PendingHold>(),
})
const isAuthority = (value: unknown): value is HoldAuthority =>
  Predicate.hasProperty(value, authorityKey) && value[authorityKey] === true

/** The native plugin loader may re-evaluate the pool graph while its old hooks finish. */
export const processHoldAuthority = (): HoldAuthority => {
  const existing = Option.flatMap(Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, authorityKey)),
    (property) => Option.liftPredicate(property.value, isAuthority),
  )
  if (Option.isSome(existing)) return existing.value
  const authority = holdAuthority()
  Object.defineProperty(globalThis, authorityKey, { value: authority })
  return authority
}

const unavailable = Clock.currentTimeMillis.pipe(Effect.map((now) => new HoldStoreUnavailable({ retryAt: now + HOLD_STORE_RETRY_MS })))
const storeFailure = () => unavailable.pipe(Effect.flatMap(Effect.fail))
const boundedStore = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.timeout(HOLD_STORE_RETRY_MS), Effect.catchCause(storeFailure))

/** Two refusals observed while the store was unread: never lift either. */
const retainBoth = (before: Hold, next: Hold): Hold => {
  let kind = next.kind
  if (before.kind === "signin" || (next.kind !== "signin" && before.until > next.until)) kind = before.kind
  const refusedUntil = Math.max(
    Option.getOrElse(Option.fromUndefinedOr(before.refusedUntil), () => 0),
    Option.getOrElse(Option.fromUndefinedOr(next.refusedUntil), () => 0),
  )
  return {
    kind, at: Math.max(before.at, next.at), until: Math.max(before.until, next.until),
    ...Option.match(Option.filter(Option.some(refusedUntil), (end) => end > 0), { onNone: () => ({}), onSome: (end) => ({ refusedUntil: end }) }),
  }
}

const settleHold = (storage: Storage, key: string, next: Option.Option<Hold>) =>
  boundedStore(Option.match(next, { onNone: () => storage.remove(key), onSome: (hold) => storage.set(key, hold) }))

const confirmedHolds = (storage: Storage, authority: ReturnType<typeof holdAuthority>, pool: PoolId) =>
  Effect.gen(function* () {
    const prefix = `${pool}/hold/`
    const now = yield* Clock.currentTimeMillis
    for (const [key, pending] of authority.pending) {
      if (!key.startsWith(prefix)) continue
      if (pending.retryAt > now) return yield* new HoldStoreUnavailable({ retryAt: pending.retryAt })
    }
    const page = yield* boundedStore(storage.scan({ prefix, limit: PAGE }))
    if (Option.isSome(Option.fromUndefinedOr(page.next))) return yield* storeFailure()
    const snapshot: Record<string, Hold> = {}
    for (const entry of page.entries) {
      const decoded = decodeHold(entry.value)
      if (Option.isNone(decoded)) return yield* storeFailure()
      snapshot[entry.key.slice(prefix.length)] = decoded.value
    }
    for (const [key, pending] of authority.pending) {
      if (!key.startsWith(prefix)) continue
      let next = pending.next
      if (pending.merge) {
        const prior = Option.fromUndefinedOr(snapshot[pending.credentialID])
        next = Option.map(next, (hold) => Option.match(prior, { onNone: () => hold, onSome: (before) => retainBoth(before, hold) }))
      }
      yield* settleHold(storage, key, next)
      Option.match(next, {
        onNone: () => { delete snapshot[pending.credentialID] },
        onSome: (hold) => { snapshot[pending.credentialID] = hold },
      })
      authority.pending.delete(key)
    }
    return snapshot
  })

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
export const layer = (storage: Storage, steps: Steps = ownSteps(storage), authority = holdAuthority()) =>
  Layer.succeed(Ledger, {
    holds: (pool) => confirmedHolds(storage, authority, pool),
    withHolds: (operation) => authority.lock.withPermits(1)(operation),
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
    // Holds are published before best-effort history. Until a failed write can
    // be retried, any decision for this pool fails closed.
    record: Effect.fn("Ledger.record")(function* (pool: PoolId, events: ReadonlyArray<Event>, shared?: "unknown") {
      const writes = events.flatMap(writesOf)
      const isHold = (write: Write) => write.key.startsWith("hold/")
      for (const write of writes.filter(isHold)) {
        const key = `${pool}/${write.key}`
        const credentialID = write.key.slice("hold/".length)
        const next = Option.flatMap(Option.liftPredicate(write, (entry) => Predicate.isTagged(entry, "Put")), (put) => decodeHold(put.value))
        if (shared === "unknown") {
          // The authoritative read failed. An old copy's expiration or
          // removal cannot clear a refusal it has not seen. Publish new
          // refusals once storage answers, keeping any stronger hold there.
          if (Option.isNone(next)) continue
          const previous = Option.flatMap(Option.fromUndefinedOr(authority.pending.get(key)), (pending) => pending.next)
          const hold = Option.match(previous, { onNone: () => next.value, onSome: (before) => retainBoth(before, next.value) })
          const { retryAt } = yield* unavailable
          authority.pending.set(key, { credentialID, next: Option.some(hold), retryAt, merge: true })
        } else {
          yield* settleHold(storage, key, next).pipe(
            Effect.tap(() => Effect.sync(() => { authority.pending.delete(key) })),
            Effect.catch(({ retryAt }) => Effect.sync(() => {
              authority.pending.set(key, { credentialID, next, retryAt, merge: false })
            })),
          )
        }
      }
      for (const event of events) yield* stepsWrite(steps(pool), event)
      for (const write of writes.filter((entry) => !isHold(entry))) {
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

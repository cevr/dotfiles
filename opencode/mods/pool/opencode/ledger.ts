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
const recoveryFields = Schema.decodeUnknownOption(Schema.Struct({
  kind: Schema.optionalKey(Schema.Unknown), until: Schema.optionalKey(Schema.Unknown),
}))
const finiteTime = Schema.decodeUnknownOption(Schema.Finite)
const rawKind = Schema.decodeUnknownOption(Schema.String)
export const UNREADABLE_HOLD_MS = 60_000
const unreadableHold = (fields: ReturnType<typeof recoveryFields>, now: number): Hold => {
  const until = Option.getOrElse(Option.flatMap(fields, (record) => finiteTime(record.until)), () => now + UNREADABLE_HOLD_MS)
  return {
    kind: "record-unreadable", until, at: now,
    ...Option.match(Option.flatMap(fields, (record) => rawKind(record.kind)), {
      onNone: () => ({}), onSome: (kind) => ({ rawKind: kind }),
    }),
  }
}

/** A failed hold write fences a send until the store has accepted it. */
type PendingHold = {
  readonly credentialID: string
  readonly retryAt: number
  readonly next: Option.Option<Hold>
  readonly merge: boolean
}
// This key and the version-neutral lock and pending fence must survive a
// format bump. A newer activation cannot approve a send alongside an older
// one: drain the old registrations first, then settle their pending writes.
const authorityKey = Symbol.for("dotfiles-opencode.pool.hold-authority.coordinator")
export const HOLD_AUTHORITY_VERSION = 1
interface HoldAuthority {
  readonly lock: Semaphore.Semaphore
  readonly pending: Map<string, PendingHold>
  readonly listed: Map<PoolId, ReadonlySet<string>>
  readonly available: () => boolean
  readonly enter: () => () => void
}
const coordinator = () => ({
  [authorityKey]: true as const,
  lock: Semaphore.makeUnsafe(1),
  pending: new Map<string, PendingHold>(),
  listed: new Map<PoolId, ReadonlySet<string>>(),
  versions: new Map<number, HoldAuthority>(),
  active: new Map<number, number>(),
})
type Coordinator = ReturnType<typeof coordinator>
const isCoordinator = (value: unknown): value is Coordinator =>
  Predicate.hasProperty(value, authorityKey) && value[authorityKey] === true
const forVersion = (shared: Coordinator, version: number): HoldAuthority => {
  const cached = Option.fromUndefinedOr(shared.versions.get(version))
  if (Option.isSome(cached)) return cached.value
  const count = () => Option.getOrElse(Option.fromUndefinedOr(shared.active.get(version)), () => 0)
  const authority: HoldAuthority = {
    lock: shared.lock,
    pending: shared.pending,
    listed: shared.listed,
    available: () => !Array.from(shared.active.keys()).some((current) => current < version),
    enter: () => {
      shared.active.set(version, count() + 1)
      return () => {
        const left = count() - 1
        if (left > 0) shared.active.set(version, left)
        else shared.active.delete(version)
      }
    },
  }
  shared.versions.set(version, authority)
  return authority
}
export const holdAuthority = (): HoldAuthority => forVersion(coordinator(), HOLD_AUTHORITY_VERSION)

/** The native plugin loader may re-evaluate the pool graph while its old hooks finish. */
export const processHoldAuthority = (version = HOLD_AUTHORITY_VERSION): HoldAuthority => {
  const existing = Option.flatMap(Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, authorityKey)),
    (property) => Option.liftPredicate(property.value, isCoordinator),
  )
  const shared = Option.getOrElse(existing, () => {
    const fresh = coordinator()
    Object.defineProperty(globalThis, authorityKey, { value: fresh })
    return fresh
  })
  return forVersion(shared, version)
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
    if (!authority.available()) return yield* storeFailure()
    const prefix = `${pool}/hold/`
    const now = yield* Clock.currentTimeMillis
    for (const [key, pending] of authority.pending) {
      if (!key.startsWith(prefix)) continue
      if (Option.exists(Option.fromUndefinedOr(authority.listed.get(pool)), (ids) => !ids.has(pending.credentialID))) {
        authority.pending.delete(key)
        continue
      }
      if (pending.retryAt > now) return yield* new HoldStoreUnavailable({ retryAt: pending.retryAt })
    }
    const snapshot: Record<string, Hold> = {}
    let after = Option.none<string>()
    do {
      const page = yield* boundedStore(storage.scan({
        prefix, limit: PAGE, ...Option.match(after, { onNone: () => ({}), onSome: (cursor) => ({ after: cursor }) }),
      }))
      for (const entry of page.entries) {
        const decoded = decodeHold(entry.value)
        const hold = Option.getOrElse(decoded, () => unreadableHold(recoveryFields(entry.value), now))
        // Persist a finite recovery time once, including when no date could
        // be recovered. A later scan must not start the same timer over.
        if (Option.isNone(decoded)) yield* settleHold(storage, entry.key, Option.some(hold)).pipe(Effect.ignore)
        Object.defineProperty(snapshot, entry.key.slice(prefix.length), { value: hold, configurable: true, enumerable: true, writable: true })
      }
      after = Option.fromUndefinedOr(page.next)
    } while (Option.isSome(after))
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
    if (!authority.available()) return yield* storeFailure()
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
  Layer.effect(Ledger, Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.sync(authority.enter), (leave) => Effect.sync(leave))
    return Ledger.of({
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
      for (const event of events) {
        if (!Predicate.isTagged(event, "LedgerPruned")) continue
        const listed = Option.fromUndefinedOr(event.listed)
        if (Option.isSome(listed)) authority.listed.set(pool, new Set(listed.value))
      }
      const listed = Option.fromUndefinedOr(authority.listed.get(pool))
      const writes = events.flatMap(writesOf)
      const isHold = (write: Write) => write.key.startsWith("hold/")
      for (const write of writes.filter(isHold)) {
        const key = `${pool}/${write.key}`
        const credentialID = write.key.slice("hold/".length)
        const next = Option.flatMap(Option.liftPredicate(write, (entry) => Predicate.isTagged(entry, "Put")), (put) => decodeHold(put.value))
        if (Option.isSome(next) && Option.exists(listed, (ids) => !ids.has(credentialID))) continue
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
  }))

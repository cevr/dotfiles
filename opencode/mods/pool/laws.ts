// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Stream } from "effect"
import {
  LedgerPruned,
  LoginsListed,
  PoolId,
  ReadingTaken,
  RequestPlaced,
  RequestRefused,
  RunReleased,
  StepRecorded,
} from "./account-pool.ts"
import type { QuotaReading } from "./quota.ts"
import { Ledger, Logins, Quota, type PublishedReading } from "./service.ts"

const pool = PoolId.make("law-pool")
const other = PoolId.make("law-other")
const missing = PoolId.make("law-missing")

const check = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R>) =>
  Effect.runPromise(body.pipe(Effect.provide(layer)))

const reading = (at: number, utilization: number): QuotaReading => ({
  at,
  status: "allowed",
  windows: [{ name: "5h", utilization, resetAt: at + 3_600_000 }],
})

// ── Ledger ──

const hold = { kind: "rate-limit", until: 2_000, at: 1_000 } as const
const step = (at: number, sessionID = "ses_law") => ({ at, sessionID, credentialID: "cred-a", cost: 0.25 })

/** `layer` makes a fresh, empty ledger each time it is called. */
export const ledgerLaws = (name: string, layer: () => Layer.Layer<Ledger>) =>
  describe(`${name} keeps the Ledger laws`, () => {
    test("a pool never recorded restores empty", () =>
      check(
        layer(),
        Effect.gen(function* () {
          expect(yield* (yield* Ledger).restore(pool)).toEqual({ holds: {}, readings: {}, steps: [] })
        }),
      ))

    test("restores the holds, readings and priced steps it recorded", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.record(pool, [
            ReadingTaken.make({ credentialID: "cred-a", reading: reading(1_000, 0.5) }),
            ReadingTaken.make({ credentialID: "cred-b", reading: reading(1_000, 1), hold: { ...hold, kind: "usage-limit" } }),
            RequestRefused.make({ credentialID: "cred-a", hold }),
            StepRecorded.make({ step: step(1_000) }),
            StepRecorded.make({ step: step(1_500, "ses_other") }),
          ])
          const restored = yield* ledger.restore(pool)
          expect(restored.holds).toEqual({ "cred-a": hold, "cred-b": { ...hold, kind: "usage-limit" } })
          expect(restored.readings).toEqual({ "cred-a": reading(1_000, 0.5), "cred-b": reading(1_000, 1) })
          expect([...restored.steps].sort((left, right) => left.at - right.at)).toEqual([step(1_000), step(1_500, "ses_other")])
        }),
      ))

    test("a newer reading or hold of an account replaces the older one", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.record(pool, [ReadingTaken.make({ credentialID: "cred-a", reading: reading(1_000, 0.5), hold })])
          yield* ledger.record(pool, [
            ReadingTaken.make({ credentialID: "cred-a", reading: reading(2_000, 0.75), hold: { ...hold, until: 9_000 } }),
          ])
          const restored = yield* ledger.restore(pool)
          expect(restored.readings).toEqual({ "cred-a": reading(2_000, 0.75) })
          expect(restored.holds).toEqual({ "cred-a": { ...hold, until: 9_000 } })
        }),
      ))

    test("a pruned step or hold is gone; the rest stays", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.record(pool, [
            RequestRefused.make({ credentialID: "cred-a", hold }),
            RequestRefused.make({ credentialID: "cred-b", hold }),
            StepRecorded.make({ step: step(1_000) }),
            StepRecorded.make({ step: step(2_000) }),
          ])
          yield* ledger.record(pool, [LedgerPruned.make({ steps: [step(1_000)], holds: ["cred-a"], runs: [], caches: [] })])
          const restored = yield* ledger.restore(pool)
          expect(restored.holds).toEqual({ "cred-b": hold })
          expect(restored.steps).toEqual([step(2_000)])
        }),
      ))

    test("events the ledger does not keep leave it as it was", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.record(pool, [
            LoginsListed.make({ credentials: ["cred-a"] }),
            RequestPlaced.make({ sessionID: "ses_law", kind: "primary", credentialID: "cred-a", at: 1_000 }),
            RunReleased.make({ sessionID: "ses_law" }),
          ])
          expect(yield* ledger.restore(pool)).toEqual({ holds: {}, readings: {}, steps: [] })
        }),
      ))

    test("one pool's ledger is not another's", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.record(pool, [RequestRefused.make({ credentialID: "cred-a", hold }), StepRecorded.make({ step: step(1_000) })])
          expect(yield* ledger.restore(other)).toEqual({ holds: {}, readings: {}, steps: [] })
        }),
      ))
  })

// ── Logins ──

/** The logins a Logins implementation reads, for the laws: each readable pool's, in order. No outside store. */
export interface LoginsWorld {
  readonly logins: ReadonlyMap<PoolId, ReadonlyArray<string>>
}

export const loginsLaws = (name: string, layer: (world: LoginsWorld) => Layer.Layer<Logins>) =>
  describe(`${name} keeps the Logins laws`, () => {
    const world: LoginsWorld = {
      logins: new Map([
        [pool, ["cred-a", "cred-b"]],
        [other, []],
      ]),
    }

    test("lists a pool's logins in order, read now or from the recent list", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const logins = yield* Logins
          expect(yield* logins.list(pool, true)).toEqual(["cred-a", "cred-b"])
          expect(yield* logins.list(pool, false)).toEqual(["cred-a", "cred-b"])
          expect(yield* logins.list(other, true)).toEqual([])
        }),
      ))

    test("a pool whose logins cannot be read fails LoginsUnavailable, naming it", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const unavailable = yield* Effect.flip((yield* Logins).list(missing, true))
          expect(unavailable._tag).toBe("LoginsUnavailable")
          expect(unavailable.pool).toBe(missing)
          expect(unavailable.message.length).toBeGreaterThan(0)
        }),
      ))

    test("a pool with no outside store lists no sources", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          expect(yield* (yield* Logins).sources(pool)).toEqual([])
        }),
      ))

    test("marking a login, listed or not, never fails", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const logins = yield* Logins
          yield* logins.list(pool, true)
          yield* logins.markSignIn(pool, "cred-a", true)
          yield* logins.markSignIn(pool, "cred-a", true)
          yield* logins.markSignIn(pool, "cred-a", false)
          yield* logins.markSignIn(pool, "cred-unknown", true)
          yield* logins.markSignIn(missing, "cred-a", true)
        }),
      ))
  })

// ── Quota ──

/** What a Quota implementation reads, for the laws: each pool's newest reading by login, and its published readings. */
export interface QuotaWorld {
  readonly readings: ReadonlyMap<PoolId, ReadonlyMap<string, QuotaReading>>
  readonly published: ReadonlyMap<PoolId, Queue.Dequeue<PublishedReading>>
}

export const quotaLaws = (name: string, layer: (world: QuotaWorld) => Layer.Layer<Quota>) =>
  describe(`${name} keeps the Quota laws`, () => {
    const newest = reading(1_000, 0.5)
    const refused: QuotaReading = { at: 2_000, status: "rejected", windows: [], refusal: { kind: "signin", until: 9_000 } }
    const readings = new Map([[pool, new Map([["cred-a", newest], ["cred-b", refused]])]])

    test("reading and usage answer a login's newest reading, and none for a login without one", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const published = new Map([[pool, yield* Queue.unbounded<PublishedReading>()]])
          yield* Effect.gen(function* () {
            const quota = yield* Quota
            expect(yield* quota.reading(pool, "cred-a")).toEqual(newest)
            expect(yield* quota.usage(pool, "cred-a")).toEqual(newest)
            expect(yield* quota.reading(pool, "cred-b")).toEqual(refused)
            expect(yield* quota.reading(pool, "cred-unknown")).toBeUndefined()
            expect(yield* quota.usage(other, "cred-a")).toBeUndefined()
          }).pipe(Effect.provide(layer({ readings, published })))
        }),
      ))

    test("readings streams what the pool's auth plugin publishes, in order", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<PublishedReading>()
          const published = new Map([[pool, queue]])
          yield* Queue.offerAll(queue, [
            { credentialID: "cred-a", reading: newest },
            { credentialID: "cred-b", reading: refused },
          ])
          const taken = yield* Effect.gen(function* () {
            return yield* (yield* Quota).readings(pool).pipe(Stream.take(2), Stream.runCollect)
          }).pipe(Effect.provide(layer({ readings, published })))
          expect([...taken]).toEqual([
            { credentialID: "cred-a", reading: newest },
            { credentialID: "cred-b", reading: refused },
          ])
        }),
      ))
  })

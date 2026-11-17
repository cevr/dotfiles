// The chunk stores over the in-memory storage the seam tests use: the fold from one key per entry (fresh, stopped
// mid-way and taken up again, an old build's key written after it), both shapes read as one, and writers in one
// process or in several on one storage. Each `Chunks.open` over a storage is one process's store.
import { describe, expect } from "bun:test"
import { Array as Arr, Deferred, Effect, Fiber, Order, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "../account-pool.ts"
import { type Step, WINDOW_MS } from "../accounts.ts"
import { storage as memory } from "../memory/ledger.ts"
import { Ledger, Limits } from "../service.ts"
import * as Chunks from "./chunks.ts"
import * as LedgerLive from "./ledger.ts"
import * as LimitsLive from "./limits.ts"
import * as Records from "./records.ts"
import { effectTest } from "../../../sim-tui/effect-test.ts"

const DAY = 24 * 3_600_000
const NOW = 30 * DAY
const ANTHROPIC = PoolId.make("anthropic")
const kind = LedgerLive.stepKind(ANTHROPIC)

const step = (at: number, sessionID: string, messageID = `msg_${sessionID}`): Step => ({ at, sessionID, credentialID: "cred-a", cost: 0.5, messageID })
const oldKey = (entry: Step) => `anthropic/step/${String(entry.at).padStart(15, "0")}/${entry.sessionID}`
const sessions = (count: number, from = NOW - DAY) => Array.from({ length: count }, (_, index) => step(from + index, `ses_${index}`))

/** A storage holding `steps` as an older pool kept them, one key each. */
const oneKeyEach = (steps: ReadonlyArray<Step>) => new Map<string, Schema.Json>(steps.map((entry) => [oldKey(entry), entry]))

const keysUnder = (entries: Map<string, Schema.Json>, prefix: string) => [...entries.keys()].filter((key) => key.startsWith(prefix))
const byTime = Order.combine(
  Order.mapInput(Order.Number, (entry: Step) => entry.at),
  Order.mapInput(Order.String, (entry: Step) => entry.sessionID),
)
const sorted = (steps: ReadonlyArray<Step>) => Arr.sort(steps, byTime)

/** The ledger a new process restores from `entries`. */
const restoreFrom = (entries: Map<string, Schema.Json>) =>
  Effect.gen(function* () {
    return yield* (yield* Ledger).restore(ANTHROPIC)
  }).pipe(Effect.provide(LedgerLive.layer(memory(entries))))

/** The limit report of a new process over `entries`, once a reading opened a 5 h row whose sums count the requests in it. */
const reportFrom = (entries: Map<string, Schema.Json>) =>
  Effect.gen(function* () {
    const limits = yield* Limits
    yield* limits.observe(ANTHROPIC, "a", { at: NOW, windows: [{ name: "5h", utilization: 0.5, resetAt: NOW + 3_600_000 }] })
    return yield* limits.report
  }).pipe(Effect.provide(LimitsLive.layer(memory(entries), "/nonexistent/pool-store-probe/limits.json")))

/** The steps a new process reads from `entries`. */
const readBack = (entries: Map<string, Schema.Json>) => Effect.map(Chunks.open(memory(entries), kind).entries, sorted)

/** `body` at NOW on the test clock. */
const atNow = <A, E>(body: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW)
    return yield* body
  }).pipe(Effect.provide(TestClock.layer()))

/** A storage whose removes fail from the `failAfter`th on: a process that stops mid-way. */
const stopping = (entries: Map<string, Schema.Json>, failAfter: number): LedgerLive.Storage => {
  const inner = memory(entries)
  const removed = { count: 0 }
  return {
    ...inner,
    remove: (key) =>
      Effect.suspend(() => {
        removed.count++
        return Effect.when(Effect.fail("the process stopped"), Effect.succeed(removed.count > failAfter)).pipe(Effect.andThen(inner.remove(key)))
      }),
  }
}

describe("the chunk store", () => {
  effectTest(
    "a fresh fold rewrites every old key as chunks and removes them; a new process reads the same steps from chunks alone",
    atNow(
      Effect.gen(function* () {
        const steps = sessions(450)
        const entries = oneKeyEach(steps)
        const store = Chunks.open(memory(entries), kind)
        expect(sorted(yield* store.entries)).toEqual(sorted(steps))
        expect(yield* store.fold).toBe(450)
        expect(keysUnder(entries, kind.legacy)).toEqual([])
        expect(keysUnder(entries, kind.prefix)).toHaveLength(3)
        expect(sorted(yield* store.entries)).toEqual(sorted(steps))
        expect(yield* readBack(entries)).toEqual(sorted(steps))
        // Folding again, in this process or the next, has nothing to do.
        expect(yield* store.fold).toBe(0)
        expect(yield* Chunks.open(memory(entries), kind).fold).toBe(0)
      }),
    ),
    5_000,
  )

  effectTest(
    "an old key past keep is removed, not carried",
    atNow(
      Effect.gen(function* () {
        const live = sessions(3)
        const old = sessions(2, NOW - WINDOW_MS - DAY).map((entry) => ({ ...entry, sessionID: `old_${entry.sessionID}` }))
        const entries = oneKeyEach([...live, ...old])
        expect(yield* Chunks.open(memory(entries), kind).fold).toBe(5)
        expect(keysUnder(entries, kind.legacy)).toEqual([])
        expect(yield* readBack(entries)).toEqual(sorted(live))
      }),
    ),
    5_000,
  )

  effectTest(
    "a fold stopped mid-way is taken up by the next process; a step both shapes hold counts once",
    atNow(
      Effect.gen(function* () {
        const steps = sessions(700)
        const entries = oneKeyEach(steps)
        // The first page's removes go through, the second's stop after its chunk was written.
        expect(yield* Chunks.open(stopping(entries, 250), kind).fold).toBe(0)
        expect(keysUnder(entries, kind.legacy)).toHaveLength(450)
        expect(keysUnder(entries, kind.prefix)).toHaveLength(2)
        expect(yield* readBack(entries)).toEqual(sorted(steps))
        const next = Chunks.open(memory(entries), kind)
        expect(yield* next.fold).toBe(450)
        expect(keysUnder(entries, kind.legacy)).toEqual([])
        expect(yield* readBack(entries)).toEqual(sorted(steps))
      }),
    ),
    5_000,
  )

  effectTest(
    "an old build's key written after the fold is read with the chunks, and folded by the next process",
    atNow(
      Effect.gen(function* () {
        const steps = sessions(10)
        const entries = oneKeyEach(steps)
        yield* Chunks.open(memory(entries), kind).fold
        const late = step(NOW - 5, "ses_late")
        entries.set(oldKey(late), late)
        const next = Chunks.open(memory(entries), kind)
        expect(sorted(yield* next.entries)).toEqual(sorted([...steps, late]))
        expect(yield* next.fold).toBe(1)
        expect(keysUnder(entries, kind.legacy)).toEqual([])
        expect(yield* readBack(entries)).toEqual(sorted([...steps, late]))
      }),
    ),
    5_000,
  )

  effectTest(
    "two processes appending to one storage at once lose nothing, and a step both appended counts once",
    atNow(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>()
        const one = Chunks.open(memory(entries), kind)
        const other = Chunks.open(memory(entries), kind)
        const first = sessions(300).map((entry) => ({ ...entry, sessionID: `one_${entry.sessionID}` }))
        const second = sessions(300).map((entry) => ({ ...entry, sessionID: `other_${entry.sessionID}` }))
        const both = step(NOW - 1, "ses_both")
        yield* Effect.all(
          [
            Effect.forEach([...first, both], one.append, { discard: true }),
            Effect.forEach([...second, both], other.append, { discard: true }),
          ],
          { concurrency: 3 },
        )
        expect(yield* readBack(entries)).toEqual(sorted([...first, ...second, both]))
      }),
    ),
    5_000,
  )

  effectTest(
    "the copies in one process share one store: the steps are read once, and appended under one writer",
    atNow(
      Effect.gen(function* () {
        const entries = oneKeyEach(sessions(5))
        const scans: Array<string> = []
        const inner = memory(entries)
        const counted: LedgerLive.Storage = { ...inner, scan: (options) => Effect.andThen(Effect.sync(() => scans.push(options.prefix)), inner.scan(options)) }
        const records = Records.make()
        const copies = [records(counted), records(counted), records(counted)]
        yield* Effect.forEach(copies, (copy) => copy.steps(ANTHROPIC).entries, { concurrency: 3 })
        expect(scans).toEqual([kind.prefix, kind.legacy])
        yield* Effect.forEach(copies, (copy, index) => copy.steps(ANTHROPIC).append(step(NOW, `ses_copy_${index}`)), { concurrency: 3 })
        expect(keysUnder(entries, kind.prefix)).toHaveLength(1)
        expect(yield* readBack(entries)).toHaveLength(8)
      }),
    ),
    5_000,
  )

  effectTest(
    "a step appended while the first read is underway is kept, in the store and in the storage",
    atNow(
      Effect.gen(function* () {
        const entries = oneKeyEach(sessions(5))
        const inner = memory(entries)
        const release = yield* Deferred.make<boolean>()
        // The first read of the old keys waits until the append has been asked for; any later read goes through.
        const legacyScans = { count: 0 }
        const slow: LedgerLive.Storage = {
          ...inner,
          scan: (options) =>
            Effect.suspend(() => {
              const first = options.prefix === kind.legacy && ++legacyScans.count === 1
              return Effect.andThen(Effect.when(Deferred.await(release), Effect.succeed(first)), inner.scan(options))
            }),
        }
        const store = Chunks.open(slow, kind)
        const reading = yield* Effect.forkChild(store.entries)
        yield* Effect.yieldNow
        const late = step(NOW, "ses_during")
        const appending = yield* Effect.forkChild(store.append(late))
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, true)
        yield* Fiber.join(appending)
        expect(yield* Fiber.join(reading)).toHaveLength(5)
        expect(sorted(yield* store.entries)).toEqual(sorted([...sessions(5), late]))
        expect(yield* readBack(entries)).toEqual(sorted([...sessions(5), late]))
      }),
    ),
    5_000,
  )

  effectTest(
    "a chunk another process expired comes back from its writer's next append holding only live steps",
    atNow(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>()
        const writer = Chunks.open(memory(entries), kind)
        yield* writer.append(step(NOW, "ses_early"))
        yield* Chunks.open(memory(entries), kind).expire(NOW)
        expect(keysUnder(entries, kind.prefix)).toEqual([])
        const later = step(NOW + WINDOW_MS, "ses_later")
        yield* writer.append(later)
        expect(yield* readBack(entries)).toEqual([later])
      }),
    ),
    5_000,
  )
})

describe("the readers on both shapes", () => {
  effectTest(
    "the ledger restores the same steps from one key each, and after the fold from chunks",
    atNow(
      Effect.gen(function* () {
        const steps = sessions(250)
        const entries = oneKeyEach(steps)
        entries.set("anthropic/hold/cred-a", { kind: "usage-limit", until: NOW + DAY, at: NOW })
        const restore = restoreFrom(entries)
        const before = yield* restore
        yield* Chunks.open(memory(entries), kind).fold
        const after = yield* restore
        expect(sorted(after.steps)).toEqual(sorted(before.steps))
        expect(after).toEqual({ ...before, steps: after.steps })
        expect(before.steps).toHaveLength(250)
        expect(before.holds).toEqual({ "cred-a": { kind: "usage-limit", until: NOW + DAY, at: NOW } })
      }),
    ),
    5_000,
  )

  effectTest(
    "the limit tally reads the same requests from one key each, and after the fold from chunks",
    atNow(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>(
          Array.from({ length: 300 }, (_, index) => [
            `${LimitsLive.PREFIX}msg_${index}`,
            { at: NOW - index * 60_000, pool: "anthropic", credentialID: "a", model: "claude-opus-5-5", tokens: { input: index, output: 1, cacheRead: 2, cacheWrite: 3 } },
          ]),
        )
        const report = reportFrom(entries)
        const before = yield* Effect.map(Chunks.open(memory(entries), LimitsLive.useKind).entries, (found) => found.length)
        const reportBefore = yield* report
        expect(reportBefore.rows).toHaveLength(1)
        expect(reportBefore.rows[0]?.sums).not.toEqual({})
        expect(yield* Chunks.open(memory(entries), LimitsLive.useKind).fold).toBe(300)
        expect(keysUnder(entries, LimitsLive.PREFIX)).toEqual([])
        expect(yield* Effect.map(Chunks.open(memory(entries), LimitsLive.useKind).entries, (found) => found.length)).toBe(before)
        expect(yield* report).toEqual(reportBefore)
      }),
    ),
    5_000,
  )
})

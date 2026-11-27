// The limit store's per-call cost does not grow with the requests it keeps: a
// tally, a report, a flush or a forecast with nothing new counts no request
// again, and a new request is counted once by each open row of its account.
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { PoolId } from "../account-pool.ts"
import { work, type Use } from "../limits.ts"
import { storage } from "../memory/ledger.ts"
import { Limits } from "../service.ts"
import type * as Chunks from "./chunks.ts"
import * as LimitsLive from "./limits.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 20)
const ANTHROPIC = PoolId.make("anthropic")
const ACCOUNTS = Array.from({ length: 7 }, (_, i) => `acct-${i}`)
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "anthropic/claude-haiku-5-5"]
const USES = 50_000
/** Each account's open rows: its 5-hour and its weekly period. */
const ROWS_PER_ACCOUNT = 2

const useAt = (i: number, at: number): Use => ({
  at,
  pool: ANTHROPIC,
  credentialID: ACCOUNTS[i % ACCOUNTS.length]!,
  model: MODELS[i % MODELS.length]!,
  tokens: { input: 1000 + (i % 97), output: 300 + (i % 13), cacheRead: 5000 + (i % 7), cacheWrite: 200 + (i % 5) },
})

/** A shared request store that holds `kept` and takes appends in memory, as records.ts's does. */
const held = (kept: ReadonlyArray<LimitsLive.Recorded>): Chunks.Store<LimitsLive.Recorded> => {
  const entries = [...kept]
  return {
    entries: Effect.sync(() => [...entries]),
    revision: Effect.sync(() => entries.length),
    append: (entry) => Effect.sync(() => void entries.push(entry)),
    expire: () => Effect.void,
    fold: Effect.succeed(0),
  }
}

// Spread over the last 6 days, so each is kept and in the weekly period.
const kept = Array.from({ length: USES }, (_, i) => ({ messageID: `m-${i}`, use: useAt(i, NOW - 6 * DAY + Math.floor((i * 6 * DAY) / USES)) }))

/** How many requests a call's row sums looked at. */
const visitsOf = <A>(call: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const before = work.visits
    yield* call
    return work.visits - before
  })

/** Each account read at NOW, then 200 new requests each with a tally, a report, a flush and a forecast: the requests each call looked at. */
const calls = Effect.gen(function* () {
  yield* TestClock.setTime(NOW)
  const limits = yield* Limits
  for (const credentialID of ACCOUNTS)
    yield* limits.observe(ANTHROPIC, credentialID, {
      at: NOW - MINUTE,
      windows: [
        { name: "5h", utilization: 0.2, resetAt: NOW + 2 * HOUR },
        { name: "7d", utilization: 0.4, resetAt: NOW + DAY },
      ],
    })
  // The first call counts the kept requests into the rows; the rest only what is new.
  const first = yield* visitsOf(limits.tally)
  const perCall: Array<number> = []
  for (let i = 0; i < 200; i++) {
    yield* TestClock.setTime(NOW + i)
    perCall.push(yield* visitsOf(Effect.andThen(limits.use(`new-${i}`, useAt(i, NOW + i)), limits.tally)))
  }
  perCall.push(yield* visitsOf(limits.report))
  perCall.push(yield* visitsOf(limits.flush))
  perCall.push(yield* visitsOf(limits.workCosts(ANTHROPIC, [{ sessionID: "s", messageIDs: ["m-1", "new-3"] }])))
  return { first, perCall }
}).pipe(
  Effect.provide(LimitsLive.layer(storage(new Map<string, Schema.Json>()), "/nonexistent/pool-sums-probe/limits.json", held(kept))),
  Effect.provide(TestClock.layer()),
)

describe("the limit store's work per call", () => {
  effectTest(
    "200 tallies, a report, a flush and a forecast over 50,000 kept requests count each new request once, on its account's rows",
    Effect.gen(function* () {
      const { first, perCall } = yield* calls
      // The first call counts each kept request on each open row of its account, once.
      expect(first).toBe(USES * ROWS_PER_ACCOUNT)
      expect(perCall).toHaveLength(203)
      // Bound: a new request is looked at once by each open row of its account; nothing else is counted again.
      expect(Math.max(...perCall)).toBeLessThanOrEqual(ROWS_PER_ACCOUNT)
    }),
    hangGuard("local-fixture"),
  )
})

// The pool model on memory layers, the claim's checks against a usage
// endpoint that rate limits a second read of one login seconds after the
// sweep's (the suspected cause of the Mac's 2026-11-25 "could not be read just
// before the claim" run): the check before the fleet's lease stands on the
// sweep's reading, the check right before the send reads anew, and a read
// that comes back unread is recorded as what it was, a claim not sent, with
// its cause, never a claim made, and goes again once the wait it asked for has
// passed. Nothing here reaches a provider: the claim is the memory quota's.
import { expect } from "bun:test"
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import * as FleetTest from "./fleet.ts"
import * as LedgerTest from "./ledger.ts"
import * as LoginsTest from "./logins.ts"
import * as OwnerTest from "./owner.ts"
import * as PeersTest from "./peers.ts"
import * as QuotaTest from "./quota.ts"
import * as ResetsTest from "./resets.ts"
import * as Model from "../model.ts"
import { type QuotaReading, unread, type UsageRead } from "../quota.ts"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const ANTHROPIC = PoolId.make("anthropic")
const RETRY_AFTER_MS = 2 * MINUTE
const NOW = Date.parse("2026-11-25T22:20:00Z")

/** One login, its 5-hour window spent, a grant that clears it expiring within the hour: due at once. */
const reading = (now: number): QuotaReading => ({
  at: now,
  usage: { at: now, samples: 1 },
  windows: [
    { name: "5h", utilization: 1, resetAt: now + 2 * HOUR },
    { name: "7d", utilization: 0.4, resetAt: now + 72 * HOUR },
  ],
  resets: { available: 1, credits: [{ id: "grant-1", count: 1, usable: true, expiresAt: now + 50 * MINUTE, clears: ["five_hour"], requiresLimit: false }] },
})

/** The pool on memory layers, its usage endpoint answering the sweep's read and rate limiting every read after it. */
const world = () => {
  const sent: Array<string> = []
  const reads: Array<"read" | "unread"> = []
  const usage = (): Effect.Effect<UsageRead> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (reads.length === 0) {
        reads.push("read")
        return Result.succeed(reading(now))
      }
      reads.push("unread")
      return unread("rate-limited", Option.some(RETRY_AFTER_MS))
    })
  const config: Model.Config = { providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS, resets: { anthropic: "claude" } }
  const integration: LoginsTest.Integration = {
    connections: new Map([[ANTHROPIC, [{ type: "credential" as const, method: "oauth" as const, id: "claude-1", label: "Claude 1" }]]]),
    marks: [],
  }
  const externals = Layer.mergeAll(
    LoginsTest.layer(integration),
    QuotaTest.layer(new Map([[ANTHROPIC, new Map()]]), new Map(), (_pool, input) => {
      sent.push(input.requestID)
      return { outcome: "reset" }
    }, usage),
    LedgerTest.layer(),
    PeersTest.layer(new Map()),
    FleetTest.layer(),
    ResetsTest.layer(new Map<string, Schema.Json>()),
    OwnerTest.layer(OwnerTest.empty()),
  )
  const pool = Effect.gen(function* () {
    const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals)))
    return Context.get(services, Model.Pool)
  })
  return { sent, reads, pool }
}

effectTest("the sweep's reading stands for the check before the lease; the read right before the send rate limited: recorded unsent with its cause, no claim made, again after the wait it asked for",
  Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        const fixture = world()
        const pool = yield* fixture.pool
        yield* pool.sweep
        // The sweep's read, then the one read right before the send: none between them.
        expect(fixture.reads).toEqual(["read", "unread"])
        expect(fixture.sent).toEqual([])
        const status = yield* pool.resets
        expect(status.claims).toEqual([])
        expect(status.resets).toHaveLength(1)
        const [reset] = status.resets
        expect(reset).toMatchObject({
          stage: "failed",
          attempts: 0,
          unsent: { why: "unread", cause: "rate-limited", tries: 1 },
          message: "not sent: the account could not be read just before the claim (rate limited, retry-after 120 s)",
        })
        expect(reset!.outcome).toBeUndefined()
        expect(reset!.retryAt).toBe(NOW + RETRY_AFTER_MS)
        // Another sweep before that wait: the claim is not tried again, and no read goes out for it.
        yield* pool.sweep
        expect(fixture.reads.filter((read) => read === "unread")).toHaveLength(2)
        expect((yield* pool.resets).resets[0]).toMatchObject({ unsent: { tries: 1 } })
    }),
  ).pipe(Effect.provide(TestClock.layer())),
  hangGuard("in-memory"),
)

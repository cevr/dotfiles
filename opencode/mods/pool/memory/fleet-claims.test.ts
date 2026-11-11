// Two hosts of the fleet, one provider: the pool model on memory layers, each
// host with its own Resets store and its own reading of one Claude account,
// both reading and claiming at one provider that applies a claim to the
// account as Claude's does. The round-2 verifier's counterexample (batch
// 2026-11-11f, B1): two hosts with fresh but different readings each picked
// another window and grant, and both were spent, the second for 0% → 0%.
//
// - Only the claimer spends: the other host claims nothing on its own and
//   forwards a yes to the claimer, which claims it under that host's request id.
// - Every claim is judged on a reading taken right before it, under one lock
//   per provider: two instances that both decided to claim (divergent
//   readings, separate stores) spend one reset; the other is recorded unsent.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import * as FleetTest from "./fleet.ts"
import * as LedgerTest from "./ledger.ts"
import * as LoginsTest from "./logins.ts"
import * as OwnerTest from "./owner.ts"
import * as PeersTest from "./peers.ts"
import * as ResetsTest from "./resets.ts"
import * as Model from "../model.ts"
import type { ClaimAnswer, QuotaReading, ResetCredit } from "../quota.ts"
import { CLAIM, type ForwardedClaim } from "../resets.ts"
import { Quota } from "../service.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ANTHROPIC = PoolId.make("anthropic")
const WINDOWS: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" }

/** One Claude account at the provider: its windows and grants as they are, and every claim it was sent. */
const provider = (windows: Record<string, { utilization: number; resetAt: number }>, grants: ReadonlyArray<ResetCredit>) => {
  const counts = new Map(grants.map((grant) => [grant.id, grant.count]))
  const seen = new Map<string, ClaimAnswer>()
  const sent: Array<{ readonly creditID: string; readonly requestID: string; readonly result: ClaimAnswer["outcome"]; readonly restored: number }> = []
  const reading = (): QuotaReading => {
    const credits = grants.map((grant) => ({ ...grant, count: counts.get(grant.id) ?? 0, usable: (counts.get(grant.id) ?? 0) > 0 }))
    return {
      at: Date.now(),
      windows: Object.entries(windows).map(([name, window]) => ({ name, ...window })),
      resets: { available: credits.filter((credit) => credit.usable).length, credits },
    }
  }
  // As Claude's endpoint: a request id it saw answers what it answered; a spent grant has none left; else the windows it clears empty.
  const claim = (input: { readonly creditID: string; readonly requestID: string }): ClaimAnswer => {
    const again = seen.get(input.requestID)
    if (again !== undefined) return { ...again, outcome: "already-redeemed" }
    const grant = grants.find((item) => item.id === input.creditID)
    const left = counts.get(input.creditID) ?? 0
    let restored = 0
    const answer: ClaimAnswer = grant === undefined || left <= 0 ? { outcome: "no-credit" } : { outcome: "reset" }
    if (answer.outcome === "reset") {
      counts.set(input.creditID, left - 1)
      for (const name of grant?.clears ?? []) {
        const window = windows[WINDOWS[name] ?? name]
        if (window !== undefined) {
          restored = Math.max(restored, window.utilization)
          window.utilization = 0
        }
      }
    }
    seen.set(input.requestID, answer)
    sent.push({ creditID: input.creditID, requestID: input.requestID, result: answer.outcome, restored })
    return answer
  }
  return { windows, reading, claim, sent }
}
type Provider = ReturnType<typeof provider>

/**
 * A host's quota: its own reading first (`snapshot`, read once, as its sweep
 * would have read it), then the provider's as it is; claims go to the provider.
 */
const hostQuota = (account: Provider, snapshot: { current: QuotaReading | undefined }) =>
  Layer.succeed(Quota, {
    reading: () => Effect.sync(() => snapshot.current ?? account.reading()),
    usage: () =>
      Effect.sync(() => {
        const read = snapshot.current ?? account.reading()
        snapshot.current = undefined
        return read
      }),
    readings: () => Stream.empty,
    claim: (_pool, input) => Effect.sync(() => account.claim(input)),
  })

/** A host's pool: `claimer` as its fleet names it, its peers' claims handed to `forward`. */
const host = (name: string, account: Provider, claimer: Model.Claimer, forward?: (claim: ForwardedClaim) => Effect.Effect<ClaimAnswer>) => {
  const snapshot: { current: QuotaReading | undefined } = { current: undefined }
  const owner = OwnerTest.empty()
  const integration: LoginsTest.Integration = {
    connections: new Map([[ANTHROPIC, [{ type: "credential" as const, method: "oauth" as const, id: "claude-a", label: "Claude A" }]]]),
    marks: [],
  }
  const config: Model.Config = {
    providers: { anthropic: ANTHROPIC },
    cacheLifeMs: CACHE_LIFE_MS,
    resets: { anthropic: "claude" },
    fleet: { ...Model.DEFAULT_FLEET, host: name },
    claimer,
  }
  const externals = Layer.mergeAll(
    LoginsTest.layer(integration),
    hostQuota(account, snapshot),
    LedgerTest.layer(),
    PeersTest.layer(
      new Map(claimer.here || claimer.peer === undefined ? [] : [[claimer.peer, { down: "not polled here" }]]),
      forward === undefined ? undefined : (_peer, claim) => forward(claim),
    ),
    FleetTest.layer(),
    ResetsTest.layer(new Map<string, Schema.Json>()),
    OwnerTest.layer(owner),
  )
  const pool = Effect.gen(function* () {
    const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals)))
    return Context.get(services, Model.Pool)
  })
  return { snapshot, owner, pool }
}

const scoped = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 20)))

/** A full grant (clears both windows) ending in two hours. */
const full = (id: string, now: number): ResetCredit => ({ id, count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day"], kind: "full", requiresLimit: false })

/** The verifier's case: two readings of one account, each fresh, each ranking another window and listing the grants in another order. */
const verifierCase = (now: number) => {
  const account = provider({ "5h": { utilization: 1, resetAt: now + 4 * HOUR }, "7d": { utilization: 1, resetAt: now + 3 * DAY } }, [full("g1", now), full("g2", now)])
  const left: QuotaReading = {
    at: now,
    windows: [
      { name: "5h", utilization: 1, resetAt: now + 4 * HOUR },
      { name: "7d", utilization: 0.8, resetAt: now + 3 * DAY },
    ],
    resets: { available: 2, credits: [full("g1", now), full("g2", now)] },
  }
  const right: QuotaReading = {
    at: now,
    windows: [
      { name: "5h", utilization: 0.2, resetAt: now + 4 * HOUR },
      { name: "7d", utilization: 1, resetAt: now + 3 * DAY },
    ],
    resets: { available: 2, credits: [full("g2", now), full("g1", now)] },
  }
  return { account, left, right }
}

describe("one account read by two hosts, claimed at one provider", () => {
  test("two instances that both decide to claim on divergent fresh readings spend one reset: the second, read again under the lock, is recorded unsent", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, left, right } = verifierCase(now)
        // Two claimers, separate stores: no decision of one is seen by the other; only the provider is shared.
        const a = host("mac", account, Model.HERE)
        const b = host("mac-too", account, Model.HERE)
        a.snapshot.current = left
        b.snapshot.current = right
        const [poolA, poolB] = [yield* a.pool, yield* b.pool]
        yield* Effect.all([poolA.sweep, poolB.sweep], { concurrency: 2 })
        expect(account.sent.filter((claim) => claim.result === "reset")).toHaveLength(1)
        expect(account.sent.every((claim) => claim.restored > 0)).toBe(true)
        const records = [...(yield* poolA.resets).claims, ...(yield* poolB.resets).claims]
        expect(records.map((claim) => claim.outcome).toSorted()).toEqual(["nothing-to-reset", "reset"])
        expect(records.find((claim) => claim.outcome === "nothing-to-reset")?.message).toMatch(/^not sent: /)
      }),
    ))

  test("the host that is not the claimer claims nothing on its own: the claimer spends the expiring reset, once", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, left, right } = verifierCase(now)
        const mac = host("mac", account, Model.HERE)
        const workbox = host("workbox", account, { here: false, peer: "mac" })
        mac.snapshot.current = left
        workbox.snapshot.current = right
        const [macPool, workboxPool] = [yield* mac.pool, yield* workbox.pool]
        yield* workboxPool.sweep
        expect(account.sent).toEqual([])
        expect((yield* workboxPool.resets).resets).toEqual([])
        yield* macPool.sweep
        yield* workboxPool.sweep
        expect(account.sent.map(({ creditID, result }) => [creditID, result])).toEqual([["g1", "reset"]])
      }),
    ))

  test("a yes on the other host is claimed on the claimer under the asking host's request id; a yes the account no longer needs is not sent", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        // A held start on a spent 5-hour window, the grant far from expiring: a question, not a claim on its own.
        const grant: ResetCredit = { id: "g", count: 2, usable: true, expiresAt: now + 60 * DAY, clears: ["five_hour"], kind: "session", requiresLimit: false }
        const account = provider({ "5h": { utilization: 1, resetAt: now + 3 * HOUR }, "7d": { utilization: 0.3, resetAt: now + 4 * DAY } }, [grant])
        const holder: { mac?: Model.Pool["Service"] } = {}
        const mac = host("mac", account, Model.HERE)
        const workbox = host("workbox", account, { here: false, peer: "mac" }, (claim) => holder.mac!.claimFor(claim))
        holder.mac = yield* mac.pool
        const workboxPool = yield* workbox.pool
        yield* Effect.forkScoped(workboxPool.followAnswers)
        yield* workboxPool.sweep
        yield* workboxPool.pace("anthropic", undefined, "ses_root")
        yield* settle
        const asked = workbox.owner.asked[0]
        expect(asked?.header).toBe("Claude reset · Claude A")
        yield* OwnerTest.answer(workbox.owner, asked!.key, CLAIM)
        yield* settle
        yield* workboxPool.reviewResets
        expect(account.sent.map(({ creditID, result }) => [creditID, result])).toEqual([["g", "reset"]])
        const record = (yield* workboxPool.resets).claims[0]
        expect(record).toMatchObject({ outcome: "reset" })
        // The claimer sent the asking host's request id: the same yes sent again is the same claim.
        expect(account.sent[0]?.requestID).toBe(record?.requestID)
        expect((yield* holder.mac.resets).claims.map((claim) => [claim.key.startsWith("forwarded:workbox:"), claim.outcome])).toEqual([[true, "reset"]])
        // The same claim forwarded again (a retry after a lost answer) spends nothing more.
        const again = yield* holder.mac.claimFor({
          host: "workbox",
          key: "other-hold",
          provider: "claude",
          creditID: "g",
          requestID: "pool-another-request",
          why: "held",
          label: "Claude A",
        })
        // The 5-hour window is empty now: a second yes for the same account is not sent.
        expect(again).toMatchObject({ outcome: "nothing-to-reset" })
        expect(account.sent).toHaveLength(1)
      }),
    ))

  test("with no peer named the claimer, a yes claims nothing and says why", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const grant: ResetCredit = { id: "g", count: 1, usable: true, expiresAt: now + 60 * DAY, clears: ["five_hour"], kind: "session", requiresLimit: false }
        const account = provider({ "5h": { utilization: 1, resetAt: now + 3 * HOUR }, "7d": { utilization: 0.3, resetAt: now + 4 * DAY } }, [grant])
        const lone = host("workbox", account, { here: false, peer: undefined })
        const pool = yield* lone.pool
        yield* Effect.forkScoped(pool.followAnswers)
        yield* pool.sweep
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* OwnerTest.answer(lone.owner, lone.owner.asked[0]!.key, CLAIM)
        yield* settle
        yield* pool.reviewResets
        expect(account.sent).toEqual([])
        expect((yield* pool.resets).claims[0]).toMatchObject({ outcome: "failed", message: "no peer is the fleet's claimer" })
      }),
    ))
})

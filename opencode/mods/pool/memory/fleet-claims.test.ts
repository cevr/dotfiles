// Two hosts of the fleet, one provider: the pool model on memory layers, each
// host with its own Resets store, its own leases and its own reading of one
// Claude account, both reading and claiming at one provider that applies a
// claim as Claude's does and keys it on its request id. The round-2
// verifier's counterexample (batch 2026-11-11f, B1): two hosts with fresh but
// different readings each picked another window and grant, and both were
// spent, the second for 0% → 0%.
//
// No host is the master: before a claim a host asks the other for the
// account's lease (lease.ts) over the fleet link, here a direct call into the
// other host's pool that a test can cut (`down`: refused at once) or silence
// (`silent`: never answers, a host asleep or gone).
// - Both online: one claim, under a lease the other granted.
// - The other offline: the host claims after the wait, on a fresh reading,
//   and the record names the fallback.
// - The link down both ways, both online: both claim, under one request id,
//   and the provider, keying on it, spends one grant.
// - A host gone mid-lease: its lease lapses, and the other proceeds.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import * as Lease from "../lease.ts"
import * as FleetTest from "./fleet.ts"
import * as LedgerTest from "./ledger.ts"
import * as LoginsTest from "./logins.ts"
import * as OwnerTest from "./owner.ts"
import * as PeersTest from "./peers.ts"
import * as ResetsTest from "./resets.ts"
import * as Model from "../model.ts"
import type { ClaimAnswer, QuotaReading, ResetCredit } from "../quota.ts"
import { PeerUnreachable, Quota } from "../service.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ANTHROPIC = PoolId.make("anthropic")
const WINDOWS: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" }
/** How long a host waits for the other's lease answer here, and how long a lease holds. */
const WAIT_MS = 100
const LEASE_MS = 300

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
  // As an endpoint keyed on its request id: an id it saw answers `already-redeemed` and spends nothing; a spent grant has none left; else the windows it clears empty.
  const claim = (input: { readonly creditID: string; readonly requestID: string }): ClaimAnswer => {
    if (seen.has(input.requestID)) {
      sent.push({ creditID: input.creditID, requestID: input.requestID, result: "already-redeemed", restored: 0 })
      return { outcome: "already-redeemed" }
    }
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
  const spent = () => sent.filter((claim) => claim.result === "reset")
  return { windows, reading, claim, sent, spent }
}
type Provider = ReturnType<typeof provider>

/**
 * How a host sees the provider: its own reading first (`snapshot`, as its
 * sweep read it), then the provider's as it is, unless it `lags` (it keeps
 * reading the snapshot); a host `away` sends a claim that never comes back.
 */
interface View {
  snapshot: QuotaReading | undefined
  lags: boolean
  away: boolean
  claiming: boolean
}

const hostQuota = (account: Provider, view: View) =>
  Layer.succeed(Quota, {
    reading: () => Effect.sync(() => view.snapshot ?? account.reading()),
    usage: () =>
      Effect.sync(() => {
        const read = view.snapshot ?? account.reading()
        if (!view.lags) view.snapshot = undefined
        return read
      }),
    readings: () => Stream.empty,
    claim: (_pool, input) =>
      Effect.suspend(() => {
        view.claiming = true
        return view.away ? Effect.never : Effect.sync(() => account.claim(input))
      }),
  })

/** The link from one host to the other: up, down (refused at once), or silent (no answer ever). */
type Link = "up" | "down" | "silent"

interface Host {
  readonly name: string
  readonly view: View
  /** How this host's asks reach the other. */
  link: Link
  pool?: Model.Pool["Service"]
}

/** Two hosts, `mac` and `workbox`, on one provider account, each the other's peer. */
const fleet = (account: Provider) => {
  const make = (name: string): Host => ({ name, view: { snapshot: undefined, lags: false, away: false, claiming: false }, link: "up" })
  const mac = make("mac")
  const workbox = make("workbox")
  const build = (self: Host, other: Host) => {
    const integration: LoginsTest.Integration = {
      connections: new Map([[ANTHROPIC, [{ type: "credential" as const, method: "oauth" as const, id: `claude-${self.name}`, label: "Claude A" }]]]),
      marks: [],
    }
    const config: Model.Config = {
      providers: { anthropic: ANTHROPIC },
      cacheLifeMs: CACHE_LIFE_MS,
      resets: { anthropic: "claude" },
      fleet: { ...Model.DEFAULT_FLEET, host: self.name, leaseMs: LEASE_MS, leaseWaitMs: WAIT_MS },
    }
    const externals = Layer.mergeAll(
      LoginsTest.layer(integration),
      hostQuota(account, self.view),
      LedgerTest.layer(),
      PeersTest.layer(new Map([[other.name, { down: "not polled here" }]]), (peer, message) => {
        if (self.link === "down") return Effect.fail(new PeerUnreachable({ peer, message: "connection refused" }))
        if (self.link === "silent" || other.pool === undefined) return Effect.never
        return other.pool.lease(message)
      }),
      FleetTest.layer(),
      ResetsTest.layer(new Map<string, Schema.Json>()),
      OwnerTest.layer(OwnerTest.empty()),
      Layer.succeed(Lease.Leases, Lease.make()),
    )
    return Effect.gen(function* () {
      const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals)))
      self.pool = Context.get(services, Model.Pool)
      return self.pool
    })
  }
  return { mac, workbox, start: Effect.all([build(mac, workbox), build(workbox, mac)]) }
}

const scoped = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const sleep = (ms: number) => Effect.promise(() => new Promise<void>((done) => setTimeout(done, ms)))

/** A full grant (clears both windows) ending in two hours: due on its own while a window is spent. */
const full = (id: string, now: number): ResetCredit => ({ id, count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day"], kind: "full", requiresLimit: false })

/** The verifier's case: the account spent, and two readings of it, each fresh, each ranking another window and listing the grants in another order. */
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

const records = (pool: Model.Pool["Service"]) => Effect.map(pool.resets, (status) => status.claims)

describe("one account read by two hosts, claimed at one provider, no host the master", () => {
  test("both online, both deciding to claim on divergent fresh readings at once: one grant spent, under the lease the other granted; the other backs off or finds it done", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, left, right } = verifierCase(now)
        const hosts = fleet(account)
        hosts.mac.view.snapshot = left
        hosts.workbox.view.snapshot = right
        const [mac, workbox] = yield* hosts.start
        yield* Effect.all([mac.sweep, workbox.sweep], { concurrency: 2 })
        expect(account.spent()).toHaveLength(1)
        expect(account.sent.every((claim) => claim.restored > 0)).toBe(true)
        const all = [...(yield* records(mac)), ...(yield* records(workbox))]
        const made = all.filter((claim) => claim.outcome === "reset")
        expect(made).toHaveLength(1)
        expect(made[0]?.lease).toMatch(/^granted by (mac|workbox)$/)
        for (const other of all.filter((claim) => claim.outcome !== "reset")) expect(other.message).toMatch(/^(backed off: |not sent: )/)
      }),
    ))

  test("the other host offline (no answer): the host claims after the wait, on a fresh reading, and the record names the fallback", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, right } = verifierCase(now)
        const hosts = fleet(account)
        hosts.workbox.view.snapshot = right
        hosts.workbox.link = "silent"
        const [, workbox] = yield* hosts.start
        const started = Date.now()
        yield* workbox.sweep
        expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS)
        expect(account.spent()).toHaveLength(1)
        const [record] = yield* records(workbox)
        expect(record).toMatchObject({ outcome: "reset", lease: `fallback: mac did not answer in ${WAIT_MS / 1000} s; sent on a fresh reading` })
      }),
    ))

  test("the link down between them, both online and both claiming on readings that lag: one request id, and the provider keying on it spends one grant", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, left, right } = verifierCase(now)
        const hosts = fleet(account)
        for (const [host, snapshot] of [
          [hosts.mac, left],
          [hosts.workbox, right],
        ] as const) {
          host.view.snapshot = snapshot
          host.view.lags = true
          host.link = "down"
        }
        const [mac, workbox] = yield* hosts.start
        yield* Effect.all([mac.sweep, workbox.sweep], { concurrency: 2 })
        // Both sent: each picked another grant, under one request id.
        expect(account.sent.map((claim) => claim.result).toSorted()).toEqual(["already-redeemed", "reset"])
        expect(new Set(account.sent.map((claim) => claim.requestID)).size).toBe(1)
        expect(account.spent()).toHaveLength(1)
        for (const record of [...(yield* records(mac)), ...(yield* records(workbox))]) expect(record.lease).toMatch(/^fallback: (mac|workbox) did not answer/)
      }),
    ))

  test("the Mac gone mid-lease (its claim never comes back, its link silent): the lease it was lent lapses, and the workbox claims", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const { account, left, right } = verifierCase(now)
        const hosts = fleet(account)
        hosts.mac.view.snapshot = left
        hosts.mac.view.away = true
        const [mac, workbox] = yield* hosts.start
        yield* Effect.forkScoped(mac.sweep)
        // The Mac holds the lease the workbox lent it, and is sending its claim when it goes.
        while (!hosts.mac.view.claiming) yield* sleep(5)
        hosts.workbox.link = "silent"
        yield* sleep(LEASE_MS + 50)
        hosts.workbox.view.snapshot = { ...right, at: Date.now() }
        yield* workbox.sweep
        expect(account.spent()).toHaveLength(1)
        const [record] = yield* records(workbox)
        expect(record).toMatchObject({ outcome: "reset", lease: expect.stringMatching(/^fallback: mac did not answer/) })
      }),
    ))
})

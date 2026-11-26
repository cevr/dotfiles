// Law 1 of the pace-hit diagnosis (2026-11-26): one line for the whole fleet. On the same readings the workbox
// answered HELD with its own claim records and the Mac OK with its own, because each host built each login's line
// from the claims it made itself. Here two hosts hold generated claims, observations and spends split any way between
// them; each builds its lines from its own records and the other's report, and the two answer alike. A host that
// cannot read its peer is never looser than the shared line.
import { expect, test } from "bun:test"
import { Option } from "effect"
import { fleetPlans, mergeRecords, type PeerPlans, Shared, Withheld } from "./fleet-plans.ts"
import { dispatchPace, poolPace } from "./pace.ts"
import type { QuotaWindow } from "./quota.ts"
import type { Claim, Spend } from "./resets.ts"
import type { AccountStatus, PlanRecords } from "./status.ts"
import { lineOf, ordinaryPlan, WEEK } from "./weekly-pace.ts"

const now = Date.parse("2026-11-26T04:00:50Z")
const HOUR = 3_600_000
const OPUS = "claude-opus-5-5"
const IDS = ["a", "b", "c", "d"]

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <A>(next: () => number, all: ReadonlyArray<A>): A => all[Math.floor(next() * all.length) % all.length]!

const week = (utilization: number, resetAt: number): QuotaWindow => ({ name: "7d", utilization, resetAt })
const account = (credentialID: string, used: number, resetAt: number): AccountStatus => ({
  credentialID, load: 0, live: 0, noRoom: false,
  reading: { at: now - 1000, usage: { at: now - 1000, samples: 2 }, windows: [week(used, resetAt), { name: "5h", utilization: 0.1, resetAt: now + HOUR }] },
})

interface World {
  readonly accounts: ReadonlyArray<AccountStatus>
  readonly claims: ReadonlyArray<Claim>
  readonly spends: ReadonlyArray<Spend>
}

/** Logins with weeks at generated use and resets, claims on them (most observed giving back the week), and requests admitted on their room. */
const worldOf = (next: () => number): World => {
  const resets = Object.fromEntries(IDS.map((id) => [id, now + HOUR + Math.floor(next() * (WEEK - 2 * HOUR))]))
  const accounts = IDS.map((id) => account(id, Math.floor(next() * 100) / 100, resets[id]!))
  const claims = Array.from({ length: Math.floor(next() * 6) }, (_, index): Claim => {
    const id = pick(next, IDS)
    const resetAt = resets[id]!
    const before = 0.3 + Math.floor(next() * 70) / 100
    const after = Math.max(0, before - Math.floor(next() * 50) / 100 - 0.01)
    return {
      key: `k${index}`, pool: "anthropic", provider: "claude", credentialID: id, label: id, creditID: "g", requestID: `r${index}`,
      at: resetAt - WEEK + 1 + Math.floor(next() * (now - (resetAt - WEEK) - 1)),
      outcome: pick(next, ["reset", "reset", "reset", "failed", "already-redeemed"] as const),
      before: [week(before, resetAt)], after: [week(after, resetAt)], weekly: "kept",
    }
  })
  const spends = claims.flatMap((claim) => Array.from({ length: Math.floor(next() * 4) }, (_, index): Spend => ({
    id: `${claim.key}-s${index}`, claim: claim.key, credentialID: claim.credentialID, at: claim.at + 1 + index, cost: 0.005 + Math.floor(next() * 5) / 100,
  })))
  return { accounts, claims, spends }
}

/** Each record to the workbox, the Mac or both. */
const split = (next: () => number, world: World): readonly [PlanRecords, PlanRecords] => {
  const where = <A>(all: ReadonlyArray<A>) => all.map((item) => ({ item, host: Math.floor(next() * 3) }))
  const claims = where(world.claims)
  const spends = where(world.spends)
  const on = (host: number): PlanRecords => ({
    claims: claims.filter((each) => each.host === host || each.host === 2).map((each) => each.item),
    spends: spends.filter((each) => each.host === host || each.host === 2).map((each) => each.item),
  })
  return [on(0), on(1)]
}

const peer = (name: string, records: PlanRecords, current = true): PeerPlans => ({ name, records: Option.some(records), current })

const answers = (world: World, plans: ReturnType<typeof fleetPlans>["plans"]) => ({
  dispatch: dispatchPace(world.accounts, now, plans, 0.005, OPUS),
  start: poolPace(world.accounts, now, { starts: [now - 60_000], cost: 0.005, settleMs: 600_000, nextCost: 0.005 }, OPUS, plans),
})

test("the measured case: the workbox claimed a reset on a login; the Mac, on the same readings, builds the same line", () => {
  // The workbox's claim on login a: observed at 75% after it, with the week at 85% and its reset two days on.
  const resetAt = now + 2 * 24 * HOUR
  const claimAt = now - 5.5 * HOUR
  const claim: Claim = {
    key: "k-a", pool: "anthropic", provider: "claude", credentialID: "a", label: "a", creditID: "g", requestID: "r",
    at: claimAt, outcome: "reset", before: [week(0.86, resetAt)], after: [week(0.75, resetAt)], weekly: "kept",
  }
  const accounts = [account("a", 0.85, resetAt), account("b", 0.96, now + 3 * 24 * HOUR)]
  const workbox: PlanRecords = { claims: [claim], spends: [] }
  const mac: PlanRecords = { claims: [], spends: [] }
  const onWorkbox = fleetPlans("claude", accounts, workbox, [peer("macbook", mac)], now)
  const onMac = fleetPlans("claude", accounts, mac, [peer("workbox", workbox)], now)
  expect(onMac.plans).toStrictEqual(onWorkbox.plans)
  expect(lineOf(resetAt, now, onMac.plans["a"])).toBe(lineOf(resetAt, now, onWorkbox.plans["a"]))
  expect(dispatchPace(accounts, now, onMac.plans, 0.005, OPUS)).toStrictEqual(dispatchPace(accounts, now, onWorkbox.plans, 0.005, OPUS))
})

test("two hosts holding generated claims, observations and spends split any way give the same pace answers", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const next = mulberry(seed)
    const world = worldOf(next)
    const [workbox, mac] = split(next, world)
    const onWorkbox = fleetPlans("claude", world.accounts, workbox, [peer("macbook", mac)], now, true)
    const onMac = fleetPlans("claude", world.accounts, mac, [peer("workbox", workbox)], now, true)
    expect({ seed, plans: onMac.plans }).toStrictEqual({ seed, plans: onWorkbox.plans })
    expect({ seed, ...answers(world, onMac.plans) }).toStrictEqual({ seed, ...answers(world, onWorkbox.plans) })
    expect(onWorkbox.source).toEqual(Shared.make({ peers: ["macbook"] }))
  }
})

test("merging the fleet's records is the same whatever the order or split: each record once, in one order", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = mulberry(seed)
    const world = worldOf(next)
    const [left, right] = split(next, world)
    expect({ seed, merged: mergeRecords([left, right]) }).toStrictEqual({ seed, merged: mergeRecords([right, left, right]) })
  }
})

test("a host that cannot read its peer is never looser than the shared line, and says which line is in force", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const next = mulberry(seed)
    const base = worldOf(next)
    // The peer admits on a claim's room only where that room is above the week's own line (a claim only adds);
    // requests it admitted since its last report reached this host are unknown here.
    const lends = (spend: Spend) => {
      const login = base.accounts.find((each) => each.credentialID === spend.credentialID)!
      const resetAt = login.reading!.windows[0]!.resetAt!
      const plan = fleetPlans("claude", base.accounts, { claims: base.claims, spends: [] }, [], now).plans[spend.credentialID]
      return lineOf(resetAt, now, plan) > lineOf(resetAt, now, ordinaryPlan(plan)) + 1e-12
    }
    const world = { ...base, spends: base.spends.filter((spend) => next() < 0.5 || lends(spend)) }
    const [workbox, mac] = split(next, world)
    // What the Mac last read of the workbox: some of its records, before it stopped answering.
    const stale: PlanRecords = { claims: workbox.claims.filter(() => next() < 0.7), spends: workbox.spends.filter((spend) => !lends(spend) && next() < 0.7) }
    const shared = fleetPlans("claude", world.accounts, workbox, [peer("macbook", mac)], now)
    const unread = fleetPlans("claude", world.accounts, mac, [peer("workbox", stale, false)], now)
    expect(unread.source).toEqual(Withheld.make({ unread: ["workbox"] }))
    const loose = answers(world, unread.plans)
    const tight = answers(world, shared.plans)
    expect({ seed, looser: (loose.dispatch.ok && !tight.dispatch.ok) || (loose.start.ok && !tight.start.ok) }).toEqual({ seed, looser: false })
  }
})

test("a peer with no report, or one too old to send its records, withholds the claims' room as a missed read does", () => {
  const next = mulberry(7)
  const world = worldOf(next)
  const records = { claims: world.claims, spends: world.spends }
  const none: PeerPlans = { name: "workbox", records: Option.none(), current: true }
  expect(fleetPlans("claude", world.accounts, records, [none], now).source).toEqual(Withheld.make({ unread: ["workbox"] }))
  expect(fleetPlans("claude", world.accounts, records, [], now).source).toEqual(Shared.make({ peers: [] }))
})

// The fleet's claim leases as a pure table: two hosts that ask for the
// provider's lease at once agree which of them claims, whatever their times
// and names; a lease lent holds others off until released or lapsed; a claim
// seen holds off an ask on a reading that may not show it yet; a host just
// started lends and claims nothing; and the verdict sends a claim no one asked
// for only on every peer's grant.
import { describe, expect, test } from "bun:test"
import { answer, begin, emptyTable, finish, hold, holds, LEASE_MS, LeaseAsk, type LeaseTable, QUIET_MS, release, SETTLE_MS, started, verdict } from "./lease.ts"

const T0 = Date.parse("2026-11-11T12:00:00Z")
const ACCOUNT = { provider: "claude" as const, grants: ["g1", "g2"] }

const askOf = (host: string, requestedAt: number, readAt = requestedAt - 1, grants = ACCOUNT.grants) =>
  LeaseAsk.make({ host, id: `${host}:${requestedAt}`, provider: "claude", grants, readAt, requestedAt, holdMs: LEASE_MS })

/** Two hosts each begin, each ask the other, then each try to hold, each at its own clock: who claims. */
const race = (left: { host: string; at: number }, right: { host: string; at: number }, order: "left first" | "right first", skew = 0) => {
  const clock = (host: string) => (host === right.host ? T0 + skew : T0)
  const tables = new Map<string, LeaseTable>([
    [left.host, emptyTable],
    [right.host, emptyTable],
  ])
  const asks = new Map([
    [left.host, askOf(left.host, left.at)],
    [right.host, askOf(right.host, right.at + skew)],
  ])
  for (const [host, ask] of asks) {
    const [why, next] = begin(tables.get(host)!, host, ask, clock(host))
    expect(why).toBeUndefined()
    tables.set(host, next)
  }
  const granted = new Map<string, boolean>()
  const pairs = order === "left first" ? [[left.host, right.host] as const, [right.host, left.host] as const] : [[right.host, left.host] as const, [left.host, right.host] as const]
  for (const [asker, peer] of pairs) {
    const [reply, next] = answer(tables.get(peer)!, peer, asks.get(asker)!, clock(peer))
    tables.set(peer, next)
    granted.set(asker, reply.granted)
  }
  return [left.host, right.host].filter((host) => granted.get(host) === true && hold(tables.get(host)!, asks.get(host)!.id, clock(host))[0])
}

describe("two hosts asking at once", () => {
  test("over ask times × names × which ask lands first: exactly one host claims, the earlier ask, then the lower name", () => {
    for (const [leftAt, rightAt] of [
      [T0, T0],
      [T0, T0 + 1],
      [T0 + 1, T0],
      [T0, T0 + 5_000],
    ])
      for (const [leftName, rightName] of [
        ["bite-cristian", "cristians-macbook-pro"],
        ["cristians-macbook-pro", "bite-cristian"],
      ])
        for (const order of ["left first", "right first"] as const) {
          const winners = race({ host: leftName!, at: leftAt! }, { host: rightName!, at: rightAt! }, order)
          const expected = leftAt! < rightAt! || (leftAt === rightAt && leftName! < rightName!) ? leftName : rightName
          expect(winners, `${leftName}@${leftAt! - T0} vs ${rightName}@${rightAt! - T0}, ${order}`).toEqual([expected])
        }
  })

  test("with the clocks five minutes apart either way, in either order: exactly one host claims (batch 2026-11-11g probe)", () => {
    for (const skew of [-300_000, -1, 0, 1, 300_000])
      for (const order of ["left first", "right first"] as const) expect(race({ host: "mac", at: T0 }, { host: "workbox", at: T0 }, order, skew), `skew ${skew}, ${order}`).toHaveLength(1)
  })
})

describe("a lease lent", () => {
  test("refuses another host until released, or until it lapses when its host went away; the same host may ask again", () => {
    const [lent, table] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    expect(lent).toEqual({ granted: true })
    expect(answer(table, "workbox", askOf("other", T0 + 1), T0 + 1)[0]).toMatchObject({ granted: false, reason: expect.stringContaining("mac holds") })
    expect(answer(table, "workbox", askOf("mac", T0 + 1), T0 + 1)[0]).toEqual({ granted: true })
    // This host may not begin on the provider either, until the lease lapses.
    expect(begin(table, "workbox", askOf("workbox", T0 + LEASE_MS - 1), T0 + LEASE_MS - 1)[0]).toContain("mac holds")
    expect(begin(table, "workbox", askOf("workbox", T0 + LEASE_MS), T0 + LEASE_MS)[0]).toBeUndefined()
    const released = release(table, { _tag: "Release", host: "mac", id: `mac:${T0}`, ...ACCOUNT }, T0 + 1)
    expect(answer(released, "workbox", askOf("other", T0 + 2), T0 + 2)[0]).toEqual({ granted: true })
  })

  test("is the provider's: one on other reset ids is a bar too (two hosts' lists of one account may share none); one on another provider is not", () => {
    const [, table] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    expect(answer(table, "workbox", askOf("other", T0, T0 - 1, ["g3"]), T0)[0]).toMatchObject({ granted: false })
    expect(answer(table, "workbox", { ...askOf("other", T0), provider: "codex" }, T0)[0]).toEqual({ granted: true })
  })

  test("the borrower's hold never outlasts what it asked for, which the lender lent at least (batch 2026-11-11g probe)", () => {
    const ask = askOf("mac", T0)
    const [, borrower] = begin(emptyTable, "mac", ask, T0)
    const [, lender] = answer(emptyTable, "workbox", ask, T0)
    const [held, holding] = hold(borrower, ask.id, T0 + 10_000)
    expect(held).toBe(true)
    expect(holds(holding, ask.id, T0 + LEASE_MS - 1)).toBe(true)
    expect(holds(holding, ask.id, T0 + LEASE_MS)).toBe(false)
    // The lender's lease runs at least as long.
    expect(begin(lender, "workbox", askOf("workbox", T0 + LEASE_MS - 1), T0 + LEASE_MS - 1)[0]).toContain("mac holds")
    // An ask that waited past its lease holds nothing.
    expect(hold(borrower, ask.id, T0 + LEASE_MS)[0]).toBe(false)
  })

  test("a claim out holds every ask off until it is finished, past the lease's end", () => {
    const ask = askOf("mac", T0)
    const [, holding] = hold(begin(emptyTable, "mac", ask, T0)[1], ask.id, T0)
    expect(answer(holding, "mac", askOf("workbox", T0 + 10 * LEASE_MS, T0 + 10 * LEASE_MS), T0 + 10 * LEASE_MS)[0]).toMatchObject({ granted: false, reason: "mac is claiming on claude" })
  })
})

describe("a claim seen", () => {
  test("a released claim refuses an ask on a reading taken before SETTLE_MS after it, and grants one on a later reading", () => {
    const [, lent] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    const seen = release(lent, { _tag: "Release", host: "mac", id: `mac:${T0}`, ...ACCOUNT, claimedAt: T0 + 10 }, T0 + 10)
    const later = T0 + 10 + SETTLE_MS
    expect(answer(seen, "workbox", askOf("other", later, T0 + 10), later)[0]).toMatchObject({ granted: false, reason: expect.stringContaining("may not show yet") })
    expect(answer(seen, "workbox", askOf("other", later, later - 1), later)[0]).toMatchObject({ granted: false })
    expect(answer(seen, "workbox", askOf("other", later, later), later)[0]).toEqual({ granted: true })
  })

  test("a peer's claim holds off this host's own next claim alike; a finished lease of its own holds nothing (its sends its Resets store keeps)", () => {
    const seen = release(emptyTable, { _tag: "Release", host: "mac", id: `mac:${T0}`, ...ACCOUNT, claimedAt: T0 + 5 }, T0 + 5)
    expect(begin(seen, "workbox", askOf("workbox", T0 + SETTLE_MS, T0 + SETTLE_MS), T0 + SETTLE_MS)[0]).toContain("may not show yet")
    expect(begin(seen, "workbox", askOf("workbox", T0 + 5 + SETTLE_MS, T0 + 5 + SETTLE_MS), T0 + 5 + SETTLE_MS)[0]).toBeUndefined()
    const ask = askOf("mac", T0)
    const [, holding] = hold(begin(emptyTable, "mac", ask, T0)[1], ask.id, T0)
    expect(finish(holding, ask.id).own).toEqual([])
  })
})

describe("a host just started", () => {
  test("lends nothing for QUIET_MS: it may have lent a lease, or sent a claim, it forgot (batch 2026-11-11g probe); its own claims its Resets store holds off", () => {
    const table = started(T0)
    expect(answer(table, "workbox", askOf("mac", T0 + QUIET_MS - 1, T0 + QUIET_MS - 1), T0 + QUIET_MS - 1)[0]).toMatchObject({
      granted: false,
      reason: expect.stringContaining("workbox started lately"),
    })
    expect(begin(table, "workbox", askOf("workbox", T0 + 1), T0 + 1)[0]).toBeUndefined()
    expect(answer(table, "workbox", askOf("mac", T0 + QUIET_MS, T0 + QUIET_MS), T0 + QUIET_MS)[0]).toEqual({ granted: true })
  })
})

describe("the verdict", () => {
  const granted = { granted: true }
  test("every peer granted: send; any refused: back off, a yes or not", () => {
    expect(verdict([{ peer: "mac", answer: granted }], false)).toEqual({ _tag: "send", granted: ["mac"], passedOver: [] })
    expect(verdict([], false)).toEqual({ _tag: "send", granted: [], passedOver: [] })
    for (const yes of [false, true])
      expect(verdict([{ peer: "mac", answer: { granted: false, reason: "busy" } }, { peer: "spare", answer: undefined }], yes)).toEqual({ _tag: "refused", reasons: ["mac: busy"] })
  })

  test("a peer that did not answer: no claim no one asked for (the owner's question); the owner's yes sends past it", () => {
    const answers = [
      { peer: "mac", answer: undefined },
      { peer: "spare", answer: granted },
    ]
    expect(verdict(answers, false)).toEqual({ _tag: "unreachable", peers: ["mac"] })
    expect(verdict(answers, true)).toEqual({ _tag: "send", granted: ["spare"], passedOver: ["mac"] })
  })
})

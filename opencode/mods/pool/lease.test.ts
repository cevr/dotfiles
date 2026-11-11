// The fleet's claim leases as a pure table: two hosts that ask for one
// account's lease at once agree which of them claims, whatever their times
// and names; a lease lent holds others off until released or lapsed; a claim
// seen holds off an ask on an older reading.
import { describe, expect, test } from "bun:test"
import { answer, begin, emptyTable, finish, hold, LEASE_MS, LeaseAsk, type LeaseTable, release } from "./lease.ts"

const T0 = Date.parse("2026-11-11T12:00:00Z")
const ACCOUNT = { provider: "claude" as const, grants: ["g1", "g2"] }

const askOf = (host: string, requestedAt: number, readAt = requestedAt - 1, grants = ACCOUNT.grants) =>
  LeaseAsk.make({ host, id: `${host}:${requestedAt}`, provider: "claude", grants, readAt, requestedAt, holdMs: LEASE_MS })

/** Two hosts each begin, each ask the other, then each try to hold: who claims. */
const race = (left: { host: string; at: number }, right: { host: string; at: number }, order: "left first" | "right first") => {
  const tables = new Map<string, LeaseTable>([
    [left.host, emptyTable],
    [right.host, emptyTable],
  ])
  const asks = new Map([
    [left.host, askOf(left.host, left.at)],
    [right.host, askOf(right.host, right.at)],
  ])
  for (const [host, ask] of asks) {
    const [why, next] = begin(tables.get(host)!, host, ask, T0)
    expect(why).toBeUndefined()
    tables.set(host, next)
  }
  const granted = new Map<string, boolean>()
  const pairs = order === "left first" ? [[left.host, right.host] as const, [right.host, left.host] as const] : [[right.host, left.host] as const, [left.host, right.host] as const]
  for (const [asker, peer] of pairs) {
    const [reply, next] = answer(tables.get(peer)!, peer, asks.get(asker)!, T0)
    tables.set(peer, next)
    granted.set(asker, reply.granted)
  }
  return [left.host, right.host].filter((host) => granted.get(host) === true && hold(tables.get(host)!, asks.get(host)!.id, LEASE_MS, T0)[0])
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
})

describe("a lease lent", () => {
  test("refuses another host until released, or until it lapses when its host went away; the same host may ask again", () => {
    const [lent, table] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    expect(lent).toEqual({ granted: true })
    expect(answer(table, "workbox", askOf("other", T0 + 1), T0 + 1)[0]).toMatchObject({ granted: false, reason: expect.stringContaining("mac holds") })
    expect(answer(table, "workbox", askOf("mac", T0 + 1), T0 + 1)[0]).toEqual({ granted: true })
    // This host may not begin on the account either, until the lease lapses.
    expect(begin(table, "workbox", askOf("workbox", T0 + LEASE_MS - 1), T0 + LEASE_MS - 1)[0]).toContain("mac holds")
    expect(begin(table, "workbox", askOf("workbox", T0 + LEASE_MS), T0 + LEASE_MS)[0]).toBeUndefined()
    const released = release(table, { _tag: "Release", host: "mac", id: `mac:${T0}`, ...ACCOUNT }, T0 + 1)
    expect(answer(released, "workbox", askOf("other", T0 + 2), T0 + 2)[0]).toEqual({ granted: true })
  })

  test("a lease on another account (no reset id in common, or another provider) is no bar", () => {
    const [, table] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    expect(answer(table, "workbox", askOf("other", T0, T0 - 1, ["g3"]), T0)[0]).toEqual({ granted: true })
    expect(answer(table, "workbox", { ...askOf("other", T0), provider: "codex" }, T0)[0]).toEqual({ granted: true })
  })
})

describe("a claim seen", () => {
  test("a released claim refuses an ask on a reading no newer than it, and grants one on a later reading", () => {
    const [, lent] = answer(emptyTable, "workbox", askOf("mac", T0), T0)
    const seen = release(lent, { _tag: "Release", host: "mac", id: `mac:${T0}`, ...ACCOUNT, claimedAt: T0 + 10 }, T0 + 10)
    expect(answer(seen, "workbox", askOf("other", T0 + 20, T0 + 10), T0 + 20)[0]).toMatchObject({ granted: false, reason: expect.stringContaining("newer than the reading") })
    expect(answer(seen, "workbox", askOf("other", T0 + 20, T0 + 11), T0 + 20)[0]).toEqual({ granted: true })
  })

  test("this host's own claim is seen too, and while it holds the lease every ask is refused", () => {
    const ask = askOf("mac", T0)
    const [, begun] = begin(emptyTable, "mac", ask, T0)
    const [held, holding] = hold(begun, ask.id, LEASE_MS, T0)
    expect(held).toBe(true)
    expect(answer(holding, "mac", askOf("workbox", T0 - 5), T0)[0]).toMatchObject({ granted: false, reason: "mac is claiming on the account" })
    const done = finish(holding, ask.id, T0 + 5)
    expect(answer(done, "mac", askOf("workbox", T0 + 6, T0 + 4), T0 + 6)[0]).toMatchObject({ granted: false })
    expect(answer(done, "mac", askOf("workbox", T0 + 6, T0 + 6), T0 + 6)[0]).toEqual({ granted: true })
  })
})

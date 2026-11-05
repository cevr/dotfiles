// What the pool reads of its accounts at a time, over states the aggregate
// folds: whether an account is held, whether a refused run fails over, and
// each account's status.
import { describe, expect, test } from "bun:test"
import { fold } from "@dotfiles/decider/decider"
import { AccountPool, LoginsListed, ReadingTaken, RequestPlaced, restored, StepRecorded, type Event } from "./account-pool.ts"
import { cacheLives, DEFAULT_RULES, held, rank, sessionAccount, shouldFailOver, status, ttlMs, WINDOW_MS } from "./accounts.ts"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

const decider = AccountPool(DEFAULT_RULES)

const pool = (...events: ReadonlyArray<Event>) => fold(decider, [LoginsListed.make({ credentials: ["a", "b"] }), ...events])
const place = (sessionID: string, credentialID: string) =>
  RequestPlaced.make({ sessionID, kind: "primary", credentialID, at: T0 })
const holdOn = (credentialID: string, until: number) =>
  ReadingTaken.make({
    credentialID,
    reading: { at: T0, windows: [], refusal: { kind: "rate-limit", until } },
    hold: { kind: "rate-limit", until, at: T0 },
  })

describe("an account", () => {
  test("is held until its hold's time, and free from then", () => {
    const state = pool(holdOn("a", T0 + 3 * HOUR))
    expect(held(state, "a", T0 + 3 * HOUR - 1)).toBe(true)
    expect(held(state, "a", T0 + 3 * HOUR)).toBe(false)
    expect(held(state, "b", T0)).toBe(false)
  })

  test("a new run ranks the accounts with the held one last", () => {
    expect(rank(pool(holdOn("a", T0 + HOUR)), "s1", T0, DEFAULT_RULES)).toEqual(["b", "a"])
  })
})

describe("a session's cache", () => {
  const MINUTE = 60_000
  const hourly = { cacheLifeMs: HOUR }

  test("lives its agent's own lifetime when its mark carries one, else the provider's", () => {
    expect(cacheLives(hourly, { credentialID: "a", at: T0, lifeMs: 5 * MINUTE }, T0 + 5 * MINUTE - 1)).toBe(true)
    expect(cacheLives(hourly, { credentialID: "a", at: T0, lifeMs: 5 * MINUTE }, T0 + 5 * MINUTE)).toBe(false)
    expect(cacheLives(hourly, { credentialID: "a", at: T0 }, T0 + HOUR - 1)).toBe(true)
  })

  test("keeps the role's lifetime through a priced step, which moves only its time", () => {
    const decider = AccountPool(hourly)
    const role = fold(decider, [
      LoginsListed.make({ credentials: ["a", "b"] }),
      RequestPlaced.make({ sessionID: "s1", kind: "primary", credentialID: "a", at: T0, cacheLifeMs: 5 * MINUTE }),
      StepRecorded.make({ step: { at: T0 + MINUTE, sessionID: "s1", credentialID: "a", cost: 1 }, cacheLifeMs: 5 * MINUTE }),
    ])
    expect(role.recent["s1"]).toEqual({ credentialID: "a", at: T0 + MINUTE, lifeMs: 5 * MINUTE })
    // A new run stays on a while the role's cache lives, against a's load; then load places it on b.
    expect(rank(role, "s1", T0 + 6 * MINUTE - 1, hourly)[0]).toBe("a")
    expect(rank(role, "s1", T0 + 6 * MINUTE, hourly)[0]).toBe("b")
  })

  test("an agent's cacheTTL reads in models.dev's duration format; anything else is none", () => {
    expect([ttlMs("5m"), ttlMs("1h"), ttlMs("30s"), ttlMs("250ms")]).toEqual([5 * MINUTE, HOUR, 30_000, 250])
    expect([ttlMs(undefined), ttlMs(5), ttlMs("5 minutes"), ttlMs("0m")]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe("a failed request", () => {
  test("fails over when its account is held and another is not", () => {
    expect(shouldFailOver(pool(place("s1", "a")), "s1", T0)).toBe(false)
    expect(shouldFailOver(pool(place("s1", "a"), holdOn("a", T0 + HOUR)), "s1", T0)).toBe(true)
  })

  test("stays when every account is held", () => {
    const state = pool(place("s1", "a"), holdOn("b", T0 + 60_000), holdOn("a", T0 + 60_000))
    expect(shouldFailOver(state, "s1", T0)).toBe(false)
  })
})

describe("the account a session is on", () => {
  const weekly = (utilization: number, resetAt: number) =>
    ReadingTaken.make({ credentialID: "b", reading: { at: T0, windows: [{ name: "7d", utilization, resetAt }] } })

  test("is where its newest primary request went out, with that account's hold and reading", () => {
    const state = pool(place("s1", "b"), holdOn("b", T0 + HOUR))
    expect(sessionAccount(state, "s1", T0 + 1, DEFAULT_RULES)).toEqual({
      credentialID: "b",
      on: "placed",
      hold: { kind: "rate-limit", until: T0 + HOUR, at: T0 },
      reading: { at: T0, windows: [], refusal: { kind: "rate-limit", until: T0 + HOUR } },
    })
    // A request of another kind does not move it.
    const titled = fold(decider, [RequestPlaced.make({ sessionID: "s1", kind: "title", credentialID: "a", at: T0 })], pool(place("s1", "b")))
    expect(sessionAccount(titled, "s1", T0, DEFAULT_RULES)?.credentialID).toBe("b")
  })

  test("reads a window that has reset since as empty, and a past hold as none", () => {
    const state = pool(place("s1", "b"), holdOn("b", T0 + HOUR), weekly(0.41, T0 + HOUR))
    expect(sessionAccount(state, "s1", T0 + 1, DEFAULT_RULES)?.reading?.windows[0]?.utilization).toBe(0.41)
    expect(sessionAccount(state, "s1", T0 + HOUR, DEFAULT_RULES)).toEqual({
      credentialID: "b",
      on: "placed",
      reading: { at: T0, windows: [{ name: "7d", utilization: 0, resetAt: T0 + HOUR }] },
    })
  })

  test("before its first request, is the pool's pick for it", () => {
    expect(sessionAccount(pool(holdOn("a", T0 + HOUR)), "s1", T0, DEFAULT_RULES)).toMatchObject({ credentialID: "b", on: "next" })
    expect(sessionAccount(pool(), "s1", T0, DEFAULT_RULES)).toEqual({ credentialID: "a", on: "next" })
  })

  test("is none in a pool with no account", () => {
    expect(sessionAccount(fold(decider, []), "s1", T0, DEFAULT_RULES)).toBeUndefined()
  })
})

describe("the status", () => {
  test("lists each account's live hold, reading, load in the window and live runs", () => {
    const state = pool(place("s1", "a"), StepRecorded.make({ step: { at: T0, sessionID: "s1", credentialID: "a", cost: 0.25 } }), holdOn("b", T0 + HOUR))
    expect(status(state, T0 + 1, DEFAULT_RULES)).toEqual([
      { credentialID: "a", load: 0.25, live: 1, noRoom: false },
      {
        credentialID: "b",
        hold: { kind: "rate-limit", until: T0 + HOUR, at: T0 },
        reading: { at: T0, windows: [], refusal: { kind: "rate-limit", until: T0 + HOUR } },
        load: 0,
        live: 0,
        noRoom: false,
      },
    ])
    expect(status(state, T0 + WINDOW_MS, DEFAULT_RULES).map((account) => [account.credentialID, account.load, account.hold])).toEqual([
      ["a", 0, undefined],
      ["b", 0, undefined],
    ])
  })

  test("of a pool restored from a ledger counts its steps and holds", () => {
    const state = fold(
      decider,
      [LoginsListed.make({ credentials: ["a", "b"] })],
      restored({
        holds: { b: { kind: "usage-limit", until: T0 + HOUR, at: T0 } },
        readings: {},
        steps: [{ at: T0, sessionID: "s1", credentialID: "a", cost: 0.25 }],
        recent: {},
      }),
    )
    expect(held(state, "b", T0 + 1)).toBe(true)
    expect(status(state, T0 + 1, DEFAULT_RULES).find((account) => account.credentialID === "a")?.load).toBe(0.25)
  })
})

// What the pool reads of its accounts at a time, over states the aggregate
// folds: whether an account is held, whether a refused run fails over, and
// each account's status.
import { describe, expect, test } from "bun:test"
import { fold } from "../../../lib/decider.ts"
import { held, rank, shouldFailOver, status, WINDOW_MS } from "../src/domain/Accounts.ts"
import { AccountPool, restored, type Event } from "../src/domain/AccountPool/AccountPool.aggregate.ts"
import { LoginsListed } from "../src/domain/AccountPool/ListLogins.command.ts"
import { RequestPlaced } from "../src/domain/AccountPool/PlaceRequest.command.ts"
import { StepRecorded } from "../src/domain/AccountPool/RecordStep.command.ts"
import { ReadingTaken } from "../src/domain/AccountPool/TakeReading.command.ts"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

const pool = (...events: ReadonlyArray<Event>) => fold(AccountPool, [LoginsListed.make({ credentials: ["a", "b"] }), ...events])
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
    expect(rank(pool(holdOn("a", T0 + HOUR)), "s1", T0)).toEqual(["b", "a"])
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

describe("the status", () => {
  test("lists each account's live hold, reading, load in the window and live runs", () => {
    const state = pool(place("s1", "a"), StepRecorded.make({ step: { at: T0, sessionID: "s1", credentialID: "a", cost: 0.25 } }), holdOn("b", T0 + HOUR))
    expect(status(state, T0 + 1)).toEqual([
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
    expect(status(state, T0 + WINDOW_MS).map((account) => [account.credentialID, account.load, account.hold])).toEqual([
      ["a", 0, undefined],
      ["b", 0, undefined],
    ])
  })

  test("of a pool restored from a ledger counts its steps and holds", () => {
    const state = fold(
      AccountPool,
      [LoginsListed.make({ credentials: ["a", "b"] })],
      restored({
        holds: { b: { kind: "usage-limit", until: T0 + HOUR, at: T0 } },
        readings: {},
        steps: [{ at: T0, sessionID: "s1", credentialID: "a", cost: 0.25 }],
      }),
    )
    expect(held(state, "b", T0 + 1)).toBe(true)
    expect(status(state, T0 + 1).find((account) => account.credentialID === "a")?.load).toBe(0.25)
  })
})

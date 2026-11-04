// The placement ranking, one case per rule: held accounts last, accounts at
// their share after those with room, then by score and weekly reset, and the
// account a session's cache is on kept within one session.
import { describe, expect, test } from "bun:test"
import { rankPlacement, type PlacementSlot } from "../src/domain/Placement.ts"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

const slot = (name: string, fields: Partial<PlacementSlot<string>> = {}): PlacementSlot<string> => ({
  slot: name,
  load: 0,
  live: 0,
  held: false,
  noRoom: false,
  ...fields,
})

describe("rankPlacement", () => {
  test("a held account is never chosen while another is eligible, and goes last", () => {
    expect(rankPlacement({ slots: [slot("a", { held: true }), slot("b"), slot("c")], spent: 0, sessions: 0 })).toEqual([
      "b",
      "c",
      "a",
    ])
  })

  test("with every account held, the preferred one, else the first", () => {
    const held = [slot("a", { held: true }), slot("b", { held: true })] as const
    expect(rankPlacement({ slots: [...held], spent: 0, sessions: 0 })[0]).toBe("a")
    expect(rankPlacement({ slots: [...held], spent: 0, sessions: 0, preferred: "b" })[0]).toBe("b")
  })

  test("among equal accounts, the soonest weekly reset wins; a missing reset goes last", () => {
    const ranked = rankPlacement({
      slots: [slot("a"), slot("b", { weeklyResetAt: T0 + 90 * HOUR }), slot("c", { weeklyResetAt: T0 + 20 * HOUR })],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["c", "b", "a"])
  })

  test("accounts below their pace come first, by the soonest weekly reset", () => {
    const ranked = rankPlacement({
      slots: [
        slot("a", { sustainable: 4, live: 1, weeklyResetAt: T0 + 90 * HOUR }),
        slot("b", { sustainable: 1, live: 1, weeklyResetAt: T0 + 10 * HOUR }),
        slot("c", { sustainable: 3, live: 2, weeklyResetAt: T0 + 30 * HOUR }),
      ],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["c", "a", "b"])
  })

  test("an account at its share goes after every account with room, whatever its score", () => {
    const ranked = rankPlacement({
      slots: [slot("full", { noRoom: true }), slot("busy", { live: 3 })],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["busy", "full"])
  })

  test("score is recorded load in mean sessions plus live sessions", () => {
    // Unit: $10 over 5 sessions = $2. a: 6/2 + 0 = 3. b: 0/2 + 2 = 2.
    const ranked = rankPlacement({ slots: [slot("a", { load: 6 }), slot("b", { live: 2 })], spent: 10, sessions: 5 })
    expect(ranked[0]).toBe("b")
  })

  test("the preferred account stays within one session of the best score, and not beyond", () => {
    const within = rankPlacement({ slots: [slot("a", { live: 1 }), slot("b")], spent: 0, sessions: 0, preferred: "a" })
    expect(within[0]).toBe("a")
    const beyond = rankPlacement({ slots: [slot("a", { live: 2 }), slot("b")], spent: 0, sessions: 0, preferred: "a" })
    expect(beyond[0]).toBe("b")
  })

  test("the preferred account at its share gives way to one with room", () => {
    const ranked = rankPlacement({
      slots: [slot("a", { noRoom: true }), slot("b")],
      spent: 0,
      sessions: 0,
      preferred: "a",
    })
    expect(ranked[0]).toBe("b")
  })
})

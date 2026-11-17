import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { maskTurnTimeInPlace, OWNER_ZONE, ownerZone, turnEnd, turnTime } from "./turn-time.ts"

const at = (iso: string) => Date.parse(iso)
const NY = OWNER_ZONE

describe("the time under a finished turn", () => {
  test("on a UTC host (the workbox): the owner's time, then the host's in 24 hours", () => {
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T03:00:00Z"), NY, "UTC")).toBe("9:12 PM ET · 02:12 UTC")
  })

  test("on a host whose offset matches the owner's (the Mac in Toronto, or New York itself): one time", () => {
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T03:00:00Z"), NY, "America/Toronto")).toBe("9:12 PM ET")
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T03:00:00Z"), NY, NY)).toBe("9:12 PM ET")
  })

  test("follows daylight time: four hours behind UTC in summer, five in winter", () => {
    expect(turnTime(at("2026-07-01T16:05:00Z"), at("2026-07-01T17:00:00Z"), NY, "UTC")).toBe("12:05 PM ET · 16:05 UTC")
    expect(turnTime(at("2026-01-15T16:05:00Z"), at("2026-01-15T17:00:00Z"), NY, "UTC")).toBe("11:05 AM ET · 16:05 UTC")
    // The night the clocks go back (Nov 1 2026, 2 AM EDT becomes 1 AM EST): both 1:30s read as 1:30 AM.
    expect(turnTime(at("2026-11-01T05:30:00Z"), at("2026-11-01T07:00:00Z"), NY, "UTC")).toBe("1:30 AM ET · 05:30 UTC")
    expect(turnTime(at("2026-11-01T06:30:00Z"), at("2026-11-01T07:00:00Z"), NY, "UTC")).toBe("1:30 AM ET · 06:30 UTC")
  })

  test("a turn older than the owner's today leads with its date, by the owner's calendar, not the host's", () => {
    // 9:12 PM ET on Nov 16 is already Nov 17 in UTC; read the next morning it is yesterday's.
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T14:00:00Z"), NY, "UTC")).toBe("Nov 16 9:12 PM ET · 02:12 UTC")
    // Read at 11 PM the same evening, it is still today for the owner though UTC has moved on.
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T04:00:00Z"), NY, "UTC")).toBe("9:12 PM ET · 02:12 UTC")
    expect(turnTime(at("2026-11-02T15:00:00Z"), at("2026-11-17T15:00:00Z"), NY, NY)).toBe("Nov 2 10:00 AM ET")
  })

  test("comes from the step's completion, its start when an interrupted step has none, and none while a retry waits", () => {
    const step = { time: { created: at("2026-11-17T02:00:00Z"), completed: at("2026-11-17T02:12:00Z") } }
    expect(turnEnd(step, at("2026-11-17T03:00:00Z"), NY, "UTC")).toEqual(Option.some("9:12 PM ET · 02:12 UTC"))
    expect(turnEnd({ time: { created: at("2026-11-17T02:00:00Z") } }, at("2026-11-17T03:00:00Z"), NY, "UTC")).toEqual(Option.some("9:00 PM ET · 02:00 UTC"))
    expect(turnEnd({ ...step, retry: { attempt: 1 } }, at("2026-11-17T03:00:00Z"), NY, "UTC")).toEqual(Option.none())
  })

  test("a frame's row is masked whatever its zones, and in place: a row moved off the right edge reads differently", () => {
    const right = (text: string) => text.padStart(105)
    const rows = ["9:12 PM ET", "10:00 AM ET · 15:00 UTC", "Nov 16 9:12 PM ET · 02:12 GMT+5:30", "9:12 PM PT · 05:12 CET"].map(right)
    expect(rows.map(maskTurnTimeInPlace)).toEqual(rows.map(() => right("<turn-time>")))
    expect(maskTurnTimeInPlace("  9:12 PM ET")).not.toBe(maskTurnTimeInPlace(right("9:12 PM ET")))
    expect(maskTurnTimeInPlace("  The build passes.")).toBe("  The build passes.")
  })

  test("the owner's zone is the plugin's `zone` option when this host knows it, else New York", () => {
    expect(ownerZone({ zone: "Europe/Lisbon" })).toBe("Europe/Lisbon")
    expect([ownerZone({}), ownerZone({ zone: "" }), ownerZone({ zone: "Mars/Olympus" }), ownerZone({ zone: 5 })]).toEqual([NY, NY, NY, NY])
  })

  test("another owner zone reads in its own short name", () => {
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T03:00:00Z"), "America/Los_Angeles", "UTC")).toBe("6:12 PM PT · 02:12 UTC")
    expect(turnTime(at("2026-11-17T02:12:00Z"), at("2026-11-17T03:00:00Z"), "UTC", NY)).toBe("2:12 AM UTC · 21:12 ET")
  })
})

// How many subagent rows the dock draws, and the line that counts the rest.
// The rows themselves are tested in mods/subagents.
import { describe, expect, test } from "bun:test"
import { capped, moreLine, sidebarShown } from "../src/rows"

describe("the rows beneath the composer", () => {
  test("a list over the cap shows the first rows in order and counts the rest", () => {
    const shown = capped(Array.from({ length: 9 }, (_, index) => `r${index}`))
    expect(shown.rows).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"])
    expect(shown.more).toBe(3)
    expect(capped([])).toEqual({ rows: [], more: 0 })
  })

  test("the count says where to see them all: ↓ from the parent, nowhere inside a subagent", () => {
    expect(moreLine(3, false)).toBe("+3 more · ↓ to see all")
    expect(moreLine(3, true)).toBe("+3 more")
    expect(moreLine(0, false)).toBe("")
  })

  test("the rows step aside while the host shows the sidebar, and always show on a host that cannot say", () => {
    const shown = new Set(["wide"])
    const host = { sidebar: { visible: (sessionID: string) => shown.has(sessionID) } }
    expect(sidebarShown(host, "wide")).toBe(true)
    expect(sidebarShown(host, "narrow")).toBe(false)
    expect(sidebarShown({}, "wide")).toBe(false)
  })
})

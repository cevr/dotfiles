// How many subagent rows the dock draws, which of them the wheel has scrolled
// into view, and the line that says where they are. The rows themselves are
// tested in mods/subagents.
import { describe, expect, test } from "bun:test"
import { compact, countLine, scrolled, windowed } from "./rows.ts"

const list = (length: number) => Array.from({ length }, (_, index) => `r${index + 1}`)

describe("the rows beneath the composer", () => {
  test("at the top, a list over the cap shows its first rows in order and counts the rest", () => {
    const shown = windowed(list(9), 0)
    expect(shown.rows).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"])
    expect(shown).toMatchObject({ offset: 0, above: 0, below: 3, total: 9 })
    expect(windowed([], 0)).toEqual({ rows: [], offset: 0, above: 0, below: 0, total: 0 })
  })

  test("scrolled, the window shows the rows from the offset, in order, the same count", () => {
    const shown = windowed(list(39), 6)
    expect(shown.rows).toEqual(["r7", "r8", "r9", "r10", "r11", "r12"])
    expect(shown).toMatchObject({ offset: 6, above: 6, below: 27 })
  })

  test("an offset past the end clamps so the window stays full: rows that left while scrolled leave no gap", () => {
    // Scrolled to the bottom of 39, then one finishes and leaves.
    const shown = windowed(list(38), 33)
    expect(shown.rows).toEqual(["r33", "r34", "r35", "r36", "r37", "r38"])
    expect(shown).toMatchObject({ offset: 32, above: 32, below: 0 })
    expect(windowed(list(4), 10)).toMatchObject({ rows: list(4), offset: 0, above: 0, below: 0 })
    expect(windowed(list(9), -3).offset).toBe(0)
  })

  test("a wheel step moves the window one row, stopping at either end; six rows or fewer never move", () => {
    expect(scrolled(0, "down", 39)).toBe(1)
    expect(scrolled(6, "up", 39)).toBe(5)
    expect(scrolled(0, "up", 39)).toBe(0)
    expect(scrolled(33, "down", 39)).toBe(33)
    expect(scrolled(0, "down", 6)).toBe(0)
    expect(scrolled(0, "down", 3)).toBe(0)
    // From a stale offset, the step starts where the window shows.
    expect(scrolled(40, "up", 38)).toBe(31)
    // Sideways steps leave it.
    expect(scrolled(4, "left", 39)).toBe(4)
  })

  test("the count line: at the top it counts the rest; scrolled it says where you are and what lies above and below", () => {
    expect(countLine(windowed(list(39), 0), false)).toBe("+33 more · ↓ to see all")
    expect(countLine(windowed(list(39), 6), false)).toBe("7–12 of 39 · 6 above, 27 below · ↓ to see all")
    expect(countLine(windowed(list(39), 33), false)).toBe("34–39 of 39 · 33 above · ↓ to see all")
    // Inside a subagent there is no way down to see them all.
    expect(countLine(windowed(list(9), 0), true)).toBe("+3 more")
    expect(countLine(windowed(list(9), 3), true)).toBe("4–9 of 9 · 3 above")
    expect(countLine(windowed(list(6), 0), false)).toBe("")
  })

  test("a phone-sized terminal draws no rows, by width or by height; a desktop one does", () => {
    // Portrait phone; phone with its keyboard up; phone on its side.
    expect(compact({ width: 48, height: 52 })).toBe(true)
    expect(compact({ width: 48, height: 24 })).toBe(true)
    expect(compact({ width: 110, height: 22 })).toBe(true)
    // A split pane on the Mac, and the edges, which keep the rows.
    expect(compact({ width: 167, height: 35 })).toBe(false)
    expect(compact({ width: 60, height: 30 })).toBe(false)
    expect(compact({ width: 59, height: 30 })).toBe(true)
    expect(compact({ width: 60, height: 29 })).toBe(true)
  })
})

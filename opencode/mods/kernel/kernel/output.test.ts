// The view of a cell's output: its head and tail within the model's budget.
import { describe, expect, test } from "bun:test"
import { viewOf } from "./output.ts"

describe("the view", () => {
  test("keeps the head and tail of long output, naming what it left out", () => {
    const view = viewOf(`${"a".repeat(300)}END`, 100)
    expect(view.length).toBeLessThan(160)
    expect(view.startsWith("a".repeat(50))).toBe(true)
    expect(view.endsWith("END")).toBe(true)
    expect(view).toContain("characters omitted")
    expect(viewOf("short", 100)).toBe("short")
  })
})

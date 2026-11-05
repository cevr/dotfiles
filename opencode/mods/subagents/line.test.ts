// A subagent row drawn as one line.
import { describe, expect, test } from "bun:test"
import { columns, fit, format, type FormatOptions } from "./line.ts"
import type { Row } from "./subagent-row.ts"

const row = (over: Partial<Row>): Row => ({
  id: "a",
  depth: 0,
  role: "implementor",
  tone: "implementor",
  unit: "Fix money parsing",
  state: "running",
  update: "editing src/money.ts",
  since: 0,
  elapsed: 72_000,
  ...over,
})
const line = (value: Row, width: number, options: FormatOptions = {}) =>
  format(value, width, { spinner: "⠋", ...options })
    .map((segment) => segment.text)
    .join("")

describe("a drawn row", () => {
  test("reads glyph, role, unit, spinner, update and time", () => {
    expect(line(row({}), 80)).toBe("◆ implementor  Fix money parsing  ⠋ editing src/money.ts · 1m 12s")
    expect(line(row({ state: "done", update: "done · 3 steps", since: undefined, elapsed: undefined }), 80)).toBe(
      "✓ implementor  Fix money parsing  done · 3 steps",
    )
    expect(line(row({ state: "blocked", update: "waiting on question: Which?" }), 80)).toBe(
      "! implementor  Fix money parsing  waiting on question: Which? · 1m 12s",
    )
    expect(line(row({ state: "failed", update: "failed · boom", elapsed: undefined }), 80)).toStartWith("✗ ")
    expect(line(row({ state: "idle", update: "idle", elapsed: undefined }), 80)).toStartWith("○ ")
  })

  test("each segment says what it is, for its colour", () => {
    expect(format(row({}), 80, { spinner: "⠋" }).map((segment) => segment.kind)).toEqual([
      "lead",
      "role",
      "faint",
      "unit",
      "faint",
      "spinner",
      "update",
      "faint",
    ])
  })

  test("by default a running row's spinner frame follows how long it has run", () => {
    expect(format(row({ elapsed: 0 }), 80).find((segment) => segment.kind === "spinner")?.text).toBe("⠋ ")
    expect(format(row({ elapsed: 250 }), 80).find((segment) => segment.kind === "spinner")?.text).toBe("⠹ ")
  })

  test("roles and units line up across rows; a long unit is cut", () => {
    const rows = [row({}), row({ id: "b", role: "planner", unit: "A very long unit of work that goes on and on" })]
    const cols = columns(rows)
    expect(cols).toEqual({ role: 11, unit: 28 })
    const [first = "", second = ""] = rows.map((value) => line(value, 100, { columns: cols }))
    expect(second).toStartWith("◆ planner      A very long unit of work th…  ⠋ ")
    expect(first.indexOf("⠋")).toBe(second.indexOf("⠋"))
  })

  test("the update gives way to the width, with an ellipsis, and the time stays", () => {
    const text = line(row({ update: "running bun test src/money.test.ts --watch" }), 60)
    expect(text).toHaveLength(60)
    expect(text).toEndWith("… · 1m 12s")
    expect(text).toStartWith("◆ implementor  Fix money parsing  ⠋ running bun")
  })

  test("never passes its width, even with no room for the update", () => {
    expect(line(row({}), 34)).toBe("◆ implementor  Fix money parsing  ")
    expect(line(row({}), 33)).toBe("◆ implementor  Fix money parsing ")
    expect(line(row({}), 20)).toBe("◆ implementor  Fix…")
    expect(Array.from(line(row({}), 10))).toHaveLength(10)
    expect(line(row({}), 0)).toBe("")
    expect(fit("abcdef", 3)).toBe("ab…")
    expect(fit("abc", 3)).toBe("abc")
  })

  test("a nested row is indented under its parent; a marking list marks the current row", () => {
    expect(line(row({ depth: 1 }), 80)).toStartWith("↳ ◆ implementor")
    expect(line(row({ depth: 2 }), 80)).toStartWith("  ↳ ◆ implementor")
    expect(line(row({}), 80, { mark: "marked" })).toStartWith("› ◆ implementor")
    expect(line(row({}), 80, { mark: "unmarked" })).toStartWith("  ◆ implementor")
  })
})

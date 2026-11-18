import { describe, expect, test } from "bun:test"
import { describeGate, gate, Gate } from "./gate.ts"

/** 2026-11-11T17:00:00Z, a Wednesday noon in Knowlton. */
const WEDNESDAY_NOON = 1_794_416_400_000
/** 2026-11-14T17:00:00Z, a Saturday noon in Knowlton: the Sabbath. */
const SATURDAY_NOON = 1_794_675_600_000

describe("the restart gate", () => {
  test("outside the Sabbath rest it is open", () => {
    expect(gate(WEDNESDAY_NOON)).toEqual(Gate.Open())
  })

  test("over the Sabbath rest it never opens, and says when the rest ends", () => {
    const held = gate(SATURDAY_NOON)
    expect(Gate.$is("Sabbath")(held)).toBe(true)
    if (!Gate.$is("Sabbath")(held)) return
    expect(held.until).toBeGreaterThan(SATURDAY_NOON)
    expect(held.until - SATURDAY_NOON).toBeLessThan(12 * 3_600_000)
    expect(gate(held.until)).toEqual(Gate.Open())
    expect(describeGate(held)).toStartWith("the Sabbath rest, until 2026-11-14T")
  })
})

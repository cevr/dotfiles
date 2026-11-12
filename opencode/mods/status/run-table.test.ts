// The status script's table as units: its rows, never its header or rule, and
// never a row with no unit or no state.
import { describe, expect, test } from "bun:test"
import { driftOf, unitsOf } from "./run-table.ts"

describe("driftOf", () => {
  test("the line under the table is the run's drift, and no unit", () => {
    const table = [
      "| Unit | State | Round | Since | Cause | Cadence |",
      "| ---- | ----- | ----- | ----- | ----- | ------- |",
      "| push | implement | 2 | 2026-11-12T02:45Z | round-1-findings.md | 3 ready or 30 min |",
      "",
      "Drift: 35 after batch-n accepted (2026-11-12T03:40Z): 1 unfolded land ×6, 3 departed ×4",
    ].join("\n")
    expect(driftOf(table)).toBe("35 after batch-n accepted (2026-11-12T03:40Z): 1 unfolded land ×6, 3 departed ×4")
    expect(unitsOf(table).map((unit) => unit.unit)).toEqual(["push"])
  })

  test("a table with no drift line has none", () => {
    expect(driftOf("| Unit | State |\n| a | plan |")).toBeUndefined()
  })
})

describe("unitsOf", () => {
  test("each row is a unit; the header and the rule are not", () => {
    const table = [
      "| Unit | State | Round | Since | Cause |",
      "| --- | --- | --- | --- | --- |",
      "| wake | implement | 1 | 2026-11-04T15:00Z | spec.md |",
      "| closed | merged abcdef1 | 2 | 2026-11-04T15:01Z | accept.log |",
      "",
    ].join("\n")
    expect(unitsOf(table)).toEqual([
      { unit: "wake", state: "implement", round: "1", since: "2026-11-04T15:00Z" },
      { unit: "closed", state: "merged abcdef1", round: "2", since: "2026-11-04T15:01Z" },
    ])
  })

  test("a row's batch cadence, when the table prints one", () => {
    const table = [
      "| Unit | State | Round | Since | Cause | Cadence |",
      "| ---- | ----- | ----- | ----- | ----- | ------- |",
      "| lexer | ready | 1 | 2026-11-04T15:00Z | round-1-findings.md | 1 ready or 15 min |",
    ].join("\n")
    expect(unitsOf(table)).toEqual([{ unit: "lexer", state: "ready", round: "1", since: "2026-11-04T15:00Z", cadence: "1 ready or 15 min" }])
  })

  test("a row with no state, a warning line and a short row", () => {
    expect(unitsOf(["| fresh |  | | |", "plan.md is over 40 KB", "| bare | plan"].join("\n"))).toEqual([
      { unit: "bare", state: "plan", round: "", since: "" },
    ])
  })

  test("no table, no units", () => {
    expect(unitsOf("")).toEqual([])
  })
})

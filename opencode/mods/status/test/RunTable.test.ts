// The status script's table as units: its rows, never its header or rule, and
// never a row with no unit or no state.
import { describe, expect, test } from "bun:test"
import { unitsOf } from "../src/domain/RunTable.ts"

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

  test("a row with no state, a warning line and a short row", () => {
    expect(unitsOf(["| fresh |  | | |", "plan.md is over 40 KB", "| bare | plan"].join("\n"))).toEqual([
      { unit: "bare", state: "plan", round: "", since: "" },
    ])
  })

  test("no table, no units", () => {
    expect(unitsOf("")).toEqual([])
  })
})

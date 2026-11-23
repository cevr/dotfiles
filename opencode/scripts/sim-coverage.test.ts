import { expect, expectTypeOf, test } from "bun:test"
import { witnesses } from "../sim/witnesses.ts"

test("required outcomes select explicit cases, in the declared order, with no seed or generated tally", () => {
  const required = ["holds", "refuses"] as const
  const input = { holds: { lease: "current" }, refuses: { lease: "expired" } } as const
  expect(witnesses(required, input)).toEqual([["holds", input.holds], ["refuses", input.refuses]])
  expectTypeOf(witnesses<typeof required[number], typeof input>).parameters.toEqualTypeOf<[ReadonlyArray<typeof required[number]>, typeof input]>()
})

// `standing` over its whole domain: no receipt, or a receipt whose head is the checkout's or another,
// whose tree is the checkout's or another, and whose checks are none, all green or one red. Each case is
// held to the rule: Current only for the same head, the same tree and green checks; Moved whenever the
// head or the tree differs; Red for the same head and tree without green checks; Missing for none.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import { type Receipt, type ReceiptCheck, type Standing, standing } from "./receipt.ts"

const NOW = { head: "head-now", tree: "tree-now" }
const CHECKS: ReadonlyArray<readonly [string, ReadonlyArray<ReceiptCheck>]> = [
  ["none", []],
  ["green", [{ command: "bun test a", code: 0, seconds: 1 }, { command: "bun test b", code: 0, seconds: 2 }]],
  ["red", [{ command: "bun test a", code: 0, seconds: 1 }, { command: "bun test b", code: 1, seconds: 2 }]],
]

const receiptOf = (head: string, tree: string, checks: ReadonlyArray<ReceiptCheck>): Receipt => ({
  repo: "/code/.rifts/app/feat-x",
  head,
  tree,
  kind: "round",
  checks,
  at: "2026-11-13T12:00:00.000Z",
})

/** The rule, stated apart from the code. */
const oracle = (head: string, tree: string, checks: string): Standing["_tag"] => {
  if (head !== NOW.head || tree !== NOW.tree) return "Moved"
  if (checks !== "green") return "Red"
  return "Current"
}

describe("standing", () => {
  test("no receipt is Missing", () => {
    expect(standing(Option.none(), NOW)._tag).toBe("Missing")
  })

  const cases = Arr.flatMap([NOW.head, "head-other"], (head) =>
    Arr.flatMap([NOW.tree, "tree-other"], (tree) => CHECKS.map(([name, checks]) => ({ head, tree, name, checks }))),
  )
  test.each(cases)("receipt head $head, tree $tree, checks $name", ({ head, tree, name, checks }) => {
    const receipt = receiptOf(head, tree, checks)
    const now = standing(Option.some(receipt), NOW)
    expect(now._tag).toBe(oracle(head, tree, name))
    // Every standing but Missing carries the receipt it read.
    expect(now).toMatchObject({ receipt })
  })
})

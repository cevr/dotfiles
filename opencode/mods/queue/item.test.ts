import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { InvalidItem, linksOf } from "./item.ts"

describe("an item's links", () => {
  test("are tidied as written: one line each, no blanks, no repeats, never the item itself", () => {
    expect(linksOf("panes", { after: ["pool", " pool ", "panes", ""], on: { accepted: " land\n + install", changes: "fix-r2", failed: " " } }, Option.none())).toEqual(
      Result.succeed({ after: ["pool"], on: { accepted: "land + install", changes: "fix-r2" } }),
    )
  })

  test("keep their value when a patch leaves them out, and clear when written empty", () => {
    const had = Option.some({ after: ["pool"], on: { accepted: "land" } })
    expect(linksOf("panes", {}, had)).toEqual(Result.succeed({ after: ["pool"], on: { accepted: "land" } }))
    expect(linksOf("panes", { after: [] }, had)).toEqual(Result.succeed({ on: { accepted: "land" } }))
    expect(linksOf("panes", { on: {} }, had)).toEqual(Result.succeed({ after: ["pool"] }))
    expect(linksOf("panes", {}, Option.none())).toEqual(Result.succeed({}))
  })

  test("an outcome is a few words, not an essay", () => {
    expect(linksOf("panes", { on: { accepted: "x".repeat(81) } }, Option.none())).toEqual(
      Result.fail(new InvalidItem({ id: "panes", reason: 'on "accepted": keep an outcome to 24 characters and what follows to 80' })),
    )
  })
})

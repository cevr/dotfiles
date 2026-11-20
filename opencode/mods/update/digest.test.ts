import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { decodeLine, encodeLine } from "@dotfiles/opencode-digest/event"
import { installOf } from "./digest.ts"

describe("the install's digest line", () => {
  test("is one valid line with the outcome, host, build and repository", () => {
    const read = decodeLine(encodeLine(installOf("mac", "rolled-back", "batch-7", "dotfiles", 5)))
    expect(Option.map(read, (event) => event._tag === "Install" && [event.host, event.outcome, Option.getOrNull(event.build), Option.getOrNull(event.repo), event.t])).toEqual(
      Option.some(["mac", "rolled-back", "batch-7", "dotfiles", 5]),
    )
  })

  test("a handoff with no reason names no build", () => {
    const read = decodeLine(encodeLine(installOf("box", "proven", "  ", "dotfiles", 5)))
    expect(Option.map(read, (event) => event._tag === "Install" && Option.isNone(event.build))).toEqual(Option.some(true))
  })
})

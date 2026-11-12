import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { kept } from "../git/source.ts"
import { appended, KEPT_LINES } from "./log.ts"
import { withFailure } from "./notice.ts"

describe("the update's files", () => {
  test("the log keeps its newest lines", () => {
    expect(appended(Option.none(), "one")).toBe("one\n")
    expect(appended(Option.some("one\n"), "two")).toBe("one\ntwo\n")
    const full = Array.from({ length: KEPT_LINES }, (_, index) => `line ${index}`).join("\n")
    const text = appended(Option.some(full), "newest")
    expect(text.split("\n").filter((line) => line !== "")).toHaveLength(KEPT_LINES)
    expect(text).toStartWith("line 1\n")
    expect(text).toEndWith("newest\n")
  })

  test("the corner's reading carries a failed update, and loses it when it clears", () => {
    const reading = { commits: 4, blocked: false, upstream: "u", build: "b", at: "t" }
    expect(withFailure(Option.some(reading), Option.some("pool: not loaded"), "now")).toEqual({ ...reading, failed: "pool: not loaded" })
    expect(withFailure(Option.some({ ...reading, failed: "old" }), Option.none(), "now")).toEqual(reading)
    expect(withFailure(Option.none(), Option.some("guard: not loaded"), "now")).toEqual({ commits: 0, blocked: false, upstream: "", build: "", at: "now", failed: "guard: not loaded" })
  })

  test("a reset leaves the files each host keeps its own", () => {
    expect(kept("codex/config.toml")).toBe(true)
    expect(kept("skills/.system/x/SKILL.md")).toBe(true)
    expect(kept("workbox/herdr-config.toml")).toBe(true)
    expect(kept("codex/other.toml")).toBe(false)
    expect(kept("opencode/package.json")).toBe(false)
  })
})

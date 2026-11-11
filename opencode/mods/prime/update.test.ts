import { describe, expect, test } from "bun:test"
import { parseUpstream, updateAvailable, upstreamFile, upstreamNotice, type UpstreamReading } from "./update.ts"

describe("updateAvailable", () => {
  test("a service on another build than the TUI's has an update for it", () => {
    expect(updateAvailable("2.2.5-prime.d22f11a9", "2.2.5-prime.cd6d8ecd")).toBe(true)
  })

  test("the same build has none", () => {
    expect(updateAvailable("2.2.5-prime.cd6d8ecd", "2.2.5-prime.cd6d8ecd")).toBe(false)
  })

  test("a service not read yet, or one that does not know its version, shows none", () => {
    expect(updateAvailable("2.2.5-prime.cd6d8ecd", undefined)).toBe(false)
    expect(updateAvailable("2.2.5-prime.cd6d8ecd", "unknown")).toBe(false)
  })
})

const reading = (commits: number, blocked: boolean): UpstreamReading => ({
  commits,
  blocked,
  upstream: "72616be4dbe772dc645640b5623cb3d6f4453bd3",
  build: "314c9607bf6ca4254f1a7b478a8d5deb15c3b910",
  at: "2026-11-11T16:36:01.987Z",
})

describe("upstreamNotice", () => {
  test("counts the upstream commits the build lacks", () => {
    expect(upstreamNotice(reading(12, false))).toEqual({ lead: "upstream +12", rest: "" })
  })

  test("says when the merge of them is blocked", () => {
    expect(upstreamNotice(reading(12, true))).toEqual({ lead: "upstream +12", rest: " · merge blocked" })
  })

  test("shows nothing when the build is current, or with no reading", () => {
    expect(upstreamNotice(reading(0, false))).toBeUndefined()
    expect(upstreamNotice(reading(0, true))).toBeUndefined()
    expect(upstreamNotice(undefined)).toBeUndefined()
  })
})

describe("upstreamFile", () => {
  test("under the XDG state dir when one is set, so a harness's scratch state hides the host's reading", () => {
    expect(upstreamFile("/home/x", "/scratch/state")).toBe("/scratch/state/opencode-daily/upstream.json")
  })

  test("under the home's .local/state otherwise", () => {
    expect(upstreamFile("/home/x", undefined)).toBe("/home/x/.local/state/opencode-daily/upstream.json")
    expect(upstreamFile("/home/x", "")).toBe("/home/x/.local/state/opencode-daily/upstream.json")
  })
})

describe("parseUpstream", () => {
  test("reads what daily writes", () => {
    expect(parseUpstream(JSON.stringify(reading(3, true)))).toEqual(reading(3, true))
  })

  test("a file that is not a reading is none", () => {
    expect(parseUpstream("")).toBeUndefined()
    expect(parseUpstream("{")).toBeUndefined()
    expect(parseUpstream(JSON.stringify({ commits: "3" }))).toBeUndefined()
  })
})

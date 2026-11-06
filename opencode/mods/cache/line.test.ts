import { describe, expect, test } from "bun:test"
import { formatAge, formatTokens, missText, shortCause, showsRow, sidebarText } from "./line.ts"
import type { Cause, Miss } from "./miss.ts"

const miss = (missedTokens: number, cause: Cause): Miss => ({
  stepID: "msg_b",
  startedAt: 0,
  model: "anthropic/claude-sonnet-4-5",
  missedTokens,
  usage: { promptTokens: missedTokens, cacheReadTokens: 0, cacheWriteTokens: missedTokens },
  cause,
})

describe("formatting", () => {
  test("tokens and ages", () => {
    expect([850, 1_400, 48_000, 1_200_000, 2_000_000].map(formatTokens)).toEqual(["850", "1k", "48k", "1.2M", "2M"])
    expect([3_200, 59_000, 6 * 60_000, 65 * 60_000, 120 * 60_000].map(formatAge)).toEqual(["3s", "59s", "6m", "1h 5m", "2h"])
  })
})

describe("missText", () => {
  test("each cause reads as the row says it", () => {
    const rows = (
      [
        [{ _tag: "ModelSwitch" }, "cache miss · 48k tokens · $0.31 · after a model switch"],
        [{ _tag: "PrefixChanged" }, "cache miss · 48k tokens · $0.31 · prefix changed inside the cache lifetime"],
        [{ _tag: "Compaction", request: false }, "cache miss · 48k tokens · $0.31 · a compaction rewrote the prefix"],
        [{ _tag: "Compaction", request: true }, "cache miss · 48k tokens · $0.31 · the compaction request missed the cached prefix"],
        [{ _tag: "LoginMoved" }, "cache miss · 48k tokens · $0.31 · the pool moved it to another login"],
        [{ _tag: "Response", ms: 360_000 }, "cache miss · 48k tokens · $0.31 · expired during a 6m response"],
        [{ _tag: "Tool", toolName: "shell", ms: 360_000 }, "cache miss · 48k tokens · $0.31 · expired during a 6m shell call"],
        [{ _tag: "Approval", ms: 420_000 }, "cache miss · 48k tokens · $0.31 · expired waiting 7m for approval"],
        [{ _tag: "Paused", ms: 420_000 }, "cache miss · 48k tokens · $0.31 · expired while the turn paused 7m"],
        [{ _tag: "Child", ms: 600_000 }, "cache miss · 48k tokens · $0.31 · expired while a subagent ran 10m"],
        [{ _tag: "Idle", ms: 3_900_000 }, "cache miss · 48k tokens · $0.31 · expired after 1h 5m idle"],
      ] as const
    ).map(([cause, text]) => [missText(miss(48_000, cause), 0.31), text])
    for (const [actual, expected] of rows) expect(actual).toBe(expected)
  })

  test("the server's word on a miss inside the lifetime: the segment that changed first, or an unchanged prefix lost", () => {
    const change = { segment: "system[1] ¶4", offsetTokens: 3_100 }
    expect(missText(miss(48_000, { _tag: "PrefixChanged", change }), 0.31)).toBe("cache miss · 48k tokens · $0.31 · prefix changed at system[1] ¶4, 3k tokens in")
    expect(missText(miss(48_000, { _tag: "Lost" }), 0.31)).toBe("cache miss · 48k tokens · $0.31 · the cache lost an unchanged prefix")
  })

  test("a cost under a cent is not named", () => {
    expect(missText(miss(30_000, { _tag: "PrefixChanged" }), 0.004)).toBe("cache miss · 30k tokens · prefix changed inside the cache lifetime")
  })
})

describe("shortCause", () => {
  test("every expiry reads expired; a changed prefix names its segment when the server named one", () => {
    const causes: ReadonlyArray<readonly [Cause, string]> = [
      [{ _tag: "ModelSwitch" }, "model switch"],
      [{ _tag: "PrefixChanged" }, "prefix changed"],
      [{ _tag: "PrefixChanged", change: { segment: "tool shell", offsetTokens: 0 } }, "prefix at tool shell"],
      [{ _tag: "Lost" }, "cache lost"],
      [{ _tag: "Compaction", request: true }, "compaction"],
      [{ _tag: "LoginMoved" }, "login moved"],
      [{ _tag: "Response", ms: 1 }, "expired"],
      [{ _tag: "Tool", toolName: "shell", ms: 1 }, "expired"],
      [{ _tag: "Approval", ms: 1 }, "expired"],
      [{ _tag: "Paused", ms: 1 }, "expired"],
      [{ _tag: "Child", ms: 1 }, "expired"],
      [{ _tag: "Idle", ms: 1 }, "expired"],
    ]
    expect(causes.map(([cause]) => shortCause(cause))).toEqual(causes.map(([, text]) => text))
  })
})

describe("showsRow", () => {
  test("20k tokens or 10 cents", () => {
    expect(showsRow(miss(20_000, { _tag: "PrefixChanged" }), 0)).toBe(true)
    expect(showsRow(miss(19_999, { _tag: "PrefixChanged" }), 0.1)).toBe(true)
    expect(showsRow(miss(19_999, { _tag: "PrefixChanged" }), 0.099)).toBe(false)
  })
})

describe("sidebarText", () => {
  test("the served share rounded down, and the misses' total from a cent", () => {
    expect(sidebarText({ promptTokens: 1_000_000, cacheReadTokens: 919_900, cacheWriteTokens: 50_000 }, 0.4249)).toBe("Cache 91% · missed $0.42")
    expect(sidebarText({ promptTokens: 1_000, cacheReadTokens: 996, cacheWriteTokens: 0 }, 0.004)).toBe("Cache 99%")
  })

  test("the cause that cost the most follows the total, only when a total shows", () => {
    const hits = { promptTokens: 1_000_000, cacheReadTokens: 919_900, cacheWriteTokens: 50_000 }
    expect(sidebarText(hits, 0.4249, "expired")).toBe("Cache 91% · missed $0.42 · expired")
    expect(sidebarText(hits, 0.004, "expired")).toBe("Cache 91%")
  })

  test("nothing before any cache activity", () => {
    expect(sidebarText({ promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0)).toBeUndefined()
    expect(sidebarText({ promptTokens: 40_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { costliestCause, judge, missedUsd, refine, turnRows, type ModelTerms } from "./ledger.ts"
import type { Step, Timeline } from "./miss.ts"
import type { StepCause } from "./request-log.ts"

const MINUTE = 60_000
const SONNET = "anthropic/claude-sonnet-4-5"
const TERMS: ModelTerms = { family: "anthropic", lifetimeMs: 5 * MINUTE, rates: [{ input: 3, cacheRead: 0.3, cacheWrite: 3.75 }] }

const step = (id: string, at: number, prompt: number, read: number, write: number, closes = false, tools: Step["tools"] = [], agent?: string): Step => ({
  type: "step",
  id,
  model: SONNET,
  startedAt: at,
  endedAt: at + 1_000,
  usage: { promptTokens: prompt, cacheReadTokens: read, cacheWriteTokens: write },
  tools,
  opener: { id: "msg_prompt", kind: "prompt" },
  closes,
  ...(agent === undefined ? {} : { agent }),
})

/** One turn: a step that runs a 6-minute shell call, the step after it, which missed 48k, and a small changed prefix. */
const TIMELINE: Timeline = [
  step("a", 0, 48_000, 0, 48_000, false, [{ name: "shell", at: 2_000, ms: 6 * MINUTE }]),
  step("b", 6 * MINUTE + 5_000, 50_000, 0, 50_000),
  step("c", 6 * MINUTE + 10_000, 52_000, 45_000, 7_000, true),
  step("d", 7 * MINUTE, 52_000, 52_000, 0, true),
]

describe("judge", () => {
  test("prices each miss by its model's terms and writes the row of a large one", () => {
    const judged = judge(TIMELINE, [], (model) => (model === SONNET ? TERMS : undefined))
    expect(judged.map((item) => [item.miss.stepID, item.miss.missedTokens, item.row])).toEqual([
      ["b", 48_000, "cache miss · 48k tokens · $0.17 · expired during a 6m shell call"],
      // 5k missed: priced and counted, but under the row's threshold.
      ["c", 5_000, undefined],
    ])
    expect(missedUsd([judged])).toBeCloseTo(0.1656 + 0.017_25, 6)
  })

  test("a miss is timed by the lifetime the previous request's agent asked for", () => {
    const HOUR = 60 * MINUTE
    const configured: ModelTerms = { ...TERMS, lifetimeMs: HOUR, configured: true }
    // A 5-minute role idle 6 minutes between two turns, on a provider that keeps an hour.
    const idle: Timeline = [
      step("a", 0, 48_000, 0, 48_000, true, [], "implementor"),
      { ...step("b", 6 * MINUTE, 48_000, 0, 48_000, true, [], "implementor"), opener: { id: "msg_next", kind: "prompt" } },
    ]
    const roles = (agent: string) => (agent === "implementor" ? "5m" : undefined)
    expect(judge(idle, [], () => configured, roles).map((item) => item.miss.cause)).toEqual([{ _tag: "Idle", ms: 6 * MINUTE }])
    // The main agent keeps the provider's hour: inside it, the prefix changed.
    expect(judge(idle, [], () => configured, () => undefined).map((item) => item.miss.cause)).toEqual([{ _tag: "PrefixChanged" }])
    // On a model whose lifetime is no setting, the fork sends no ttl, so the agent's is not applied.
    expect(judge(idle, [], () => ({ ...TERMS, lifetimeMs: HOUR }), roles).map((item) => item.miss.cause)).toEqual([{ _tag: "PrefixChanged" }])
  })

  test("a changed prefix takes the server's judgement of its step; an expiry stands as the fold named it", () => {
    const HOUR = 60 * MINUTE
    // An hour's cache: step b's 48k miss falls inside it, so the fold calls it a changed prefix.
    const hour = (model: string) => (model === SONNET ? { ...TERMS, lifetimeMs: HOUR } : undefined)
    const causeOf = (server: Record<string, StepCause>) =>
      judge(TIMELINE, [], hour, () => undefined, (stepID) => server[stepID]).find((item) => item.miss.stepID === "b")?.miss
    const change = { segment: "system[1] ¶4", offsetTokens: 3_100, head: "Today is Friday" }
    expect(causeOf({})?.cause).toEqual({ _tag: "PrefixChanged" })
    expect(causeOf({ b: { messageID: "b", cause: "prefix", change } })?.cause).toEqual({
      _tag: "PrefixChanged",
      change: { segment: "system[1] ¶4", offsetTokens: 3_100 },
    })
    expect(causeOf({ b: { messageID: "b", cause: "unchanged" } })?.cause).toEqual({ _tag: "Lost" })
    expect(causeOf({ b: { messageID: "b", cause: "login" } })?.cause).toEqual({ _tag: "LoginMoved" })
    // The row reads the server's segment.
    expect(judge(TIMELINE, [], hour, () => undefined, (stepID) => (stepID === "b" ? { messageID: "b", cause: "prefix", change } : undefined))[0]?.row).toBe(
      "cache miss · 48k tokens · $0.27 · prefix changed at system[1] ¶4, 3k tokens in",
    )
    // On the 5-minute cache the 6-minute shell call expired it, whatever the server compared.
    expect(judge(TIMELINE, [], () => TERMS, () => undefined, () => ({ messageID: "b", cause: "unchanged" }))[0]?.miss.cause).toEqual({
      _tag: "Tool",
      toolName: "shell",
      ms: 6 * MINUTE,
    })
  })

  test("refine leaves every cause but a changed prefix alone", () => {
    expect(refine({ _tag: "Idle", ms: 1 }, { messageID: "b", cause: "login" })).toEqual({ _tag: "Idle", ms: 1 })
    expect(refine({ _tag: "PrefixChanged" }, { messageID: "b", cause: "compaction" })).toEqual({ _tag: "PrefixChanged" })
    expect(refine({ _tag: "PrefixChanged" }, undefined)).toEqual({ _tag: "PrefixChanged" })
  })

  test("a model the catalog does not know: no lifetime, no price, so only a switch would count", () => {
    expect(judge(TIMELINE, [], () => undefined)).toEqual([])
  })
})

describe("costliestCause", () => {
  test("the cause whose misses cost a family the most, across its sessions; none when nothing cost", () => {
    const judged = judge(TIMELINE, [], () => TERMS)
    // b expired ($0.17), c changed its prefix ($0.02).
    expect(costliestCause([judged])).toBe("expired")
    const changed = judge(TIMELINE.slice(1), [], () => TERMS)
    expect(costliestCause([changed])).toBe("prefix changed")
    expect(costliestCause([judged, changed, changed])).toBe("expired")
    expect(costliestCause([judge(TIMELINE, [], () => ({ family: "anthropic", lifetimeMs: 5 * MINUTE, rates: [] }))])).toBeUndefined()
    expect(costliestCause([])).toBeUndefined()
  })
})

describe("turnRows", () => {
  const judged = judge(TIMELINE, [], () => TERMS)
  test("the turn a closing step ends shows its steps' rows", () => {
    expect(turnRows(TIMELINE, judged, "c")).toEqual(["cache miss · 48k tokens · $0.17 · expired during a 6m shell call"])
  })

  test("the next turn starts after the closing step; an unknown message shows nothing", () => {
    expect(turnRows(TIMELINE, judged, "d")).toEqual([])
    expect(turnRows(TIMELINE, judged, "msg_unknown")).toEqual([])
  })

  const HOUR = 60 * MINUTE
  const hour = () => ({ ...TERMS, lifetimeMs: HOUR, configured: true })
  const summary = (id: string, at: number, prompt: number, read: number, write: number): Step => ({ ...step(id, at, prompt, read, write), compaction: true })

  // ses_e46c7a8e4ffedkRL0wCTsFSVma's shape: a turn closes, an idle compaction
  // 55 minutes later misses the conversation it summarizes, and the next turn
  // opens 36 hours on, past the cache's hour.
  const COMPACTED_AT = 41_000 + 55 * MINUTE
  const LATER = COMPACTED_AT + 36 * HOUR + 16 * MINUTE
  const IDLE_COMPACTED: Timeline = [
    step("a", 0, 161_083, 161_081, 0),
    step("b", 41_000, 166_082, 161_469, 4_611, true),
    summary("cmp", COMPACTED_AT, 146_594, 17_611, 128_979),
    { type: "compaction" },
    { ...step("c", LATER, 43_227, 0, 42_423), opener: { id: "msg_next", kind: "prompt" } },
    { ...step("d", LATER + 5_000, 44_276, 42_423, 1_851, true), opener: { id: "msg_next", kind: "prompt" } },
  ]

  test("a compaction after a closed turn shows its own miss; the turn that follows it, however much later, shows only its own", () => {
    const compacted = judge(IDLE_COMPACTED, [], hour)
    expect(compacted.map((item) => [item.miss.stepID, item.miss.cause._tag])).toEqual([
      ["cmp", "Compaction"],
      ["c", "Idle"],
    ])
    expect(turnRows(IDLE_COMPACTED, compacted, "cmp")).toEqual([
      expect.stringMatching(/^cache miss · 129k tokens · \$[\d.]+ · the compaction request missed the cached prefix$/),
    ])
    expect(turnRows(IDLE_COMPACTED, compacted, "d")).toEqual([expect.stringMatching(/^cache miss · 43k tokens · \$[\d.]+ · expired after 36h 16m idle$/)])
    expect(turnRows(IDLE_COMPACTED, compacted, "b")).toEqual([])
  })

  test("a compaction inside a turn shows its own miss, and the turn around it keeps the misses of its own steps", () => {
    const midTurn: Timeline = [
      step("a", 0, 48_000, 0, 48_000, false, [{ name: "shell", at: 2_000, ms: 6 * MINUTE }]),
      step("b", 6 * MINUTE + 5_000, 50_000, 0, 50_000),
      summary("cmp", 6 * MINUTE + 10_000, 50_000, 0, 50_000),
      { type: "compaction" },
      step("c", 6 * MINUTE + 20_000, 8_000, 0, 8_000, true),
    ]
    const compacted = judge(midTurn, [], () => TERMS)
    expect(turnRows(midTurn, compacted, "cmp")).toEqual([expect.stringContaining("the compaction request missed the cached prefix")])
    expect(turnRows(midTurn, compacted, "c")).toEqual(["cache miss · 48k tokens · $0.17 · expired during a 6m shell call"])
  })
})

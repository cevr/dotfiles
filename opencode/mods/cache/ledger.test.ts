import { describe, expect, test } from "bun:test"
import { judge, missedUsd, turnRows, type ModelTerms } from "./ledger.ts"
import type { Step, Timeline } from "./miss.ts"

const MINUTE = 60_000
const SONNET = "anthropic/claude-sonnet-4-5"
const TERMS: ModelTerms = { family: "anthropic", lifetimeMs: 5 * MINUTE, rates: [{ input: 3, cacheRead: 0.3, cacheWrite: 3.75 }] }

const step = (id: string, at: number, prompt: number, read: number, write: number, closes = false, tools: Step["tools"] = []): Step => ({
  type: "step",
  id,
  model: SONNET,
  startedAt: at,
  endedAt: at + 1_000,
  usage: { promptTokens: prompt, cacheReadTokens: read, cacheWriteTokens: write },
  tools,
  opener: { id: "msg_prompt", kind: "prompt" },
  closes,
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

  test("a model the catalog does not know: no lifetime, no price, so only a switch would count", () => {
    expect(judge(TIMELINE, [], () => undefined)).toEqual([])
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
})

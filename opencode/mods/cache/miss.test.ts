import { describe, expect, test } from "bun:test"
import { NOISE_FLOOR_TOKENS, resolve, scan, type Cause, type Opener, type Span, type Step, type Timeline } from "./miss.ts"

const MINUTE = 60_000
const FIVE_MINUTES = 5 * MINUTE
const PROMPT: Opener = { id: "msg_prompt", kind: "prompt" }

/** A step at `at` (ms) on `model`, with this prompt and cache use; it answers in 2 s. */
const step = (
  id: string,
  at: number,
  usage: { prompt: number; read: number; write?: number } | undefined,
  options: { model?: string; opener?: Opener; tools?: ReadonlyArray<Span>; endedAt?: number } = {},
): Step => ({
  type: "step",
  id,
  model: options.model ?? "anthropic/claude-sonnet-4-5",
  startedAt: at,
  endedAt: options.endedAt ?? at + 2_000,
  ...(usage === undefined ? {} : { usage: { promptTokens: usage.prompt, cacheReadTokens: usage.read, cacheWriteTokens: usage.write ?? 0 } }),
  tools: options.tools ?? [],
  opener: options.opener ?? PROMPT,
  closes: false,
})

/** The cause of the one miss `timeline` has, by a lifetime of `lifetime`. */
const causeOf = (timeline: Timeline, lifetime = FIVE_MINUTES, waits: ReadonlyArray<Span> = []): Cause | undefined => {
  const found = scan(timeline, waits)
  expect(found).toHaveLength(1)
  const [only] = found
  return only === undefined ? undefined : resolve(only, lifetime)?.cause
}

describe("scan", () => {
  test("a step that reads back the previous prompt misses nothing", () => {
    expect(scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", 10_000, { prompt: 42_000, read: 40_000, write: 2_000 })])).toEqual([])
  })

  test("the missed tokens are the smaller prompt less the cache read, and the floor is noise", () => {
    const at = (read: number) => scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", 1_000, { prompt: 50_000, read, write: 1 })])
    expect(at(40_000 - NOISE_FLOOR_TOKENS)).toEqual([])
    expect(at(40_000 - NOISE_FLOOR_TOKENS - 1).map((miss) => miss.missedTokens)).toEqual([NOISE_FLOOR_TOKENS + 1])
    expect(at(10_000).map((miss) => [miss.stepID, miss.missedTokens])).toEqual([["b", 30_000]])
  })

  test("a session that never reported cache activity has no misses: its provider reports none", () => {
    expect(scan([step("a", 0, { prompt: 40_000, read: 0 }), step("b", 1_000, { prompt: 40_000, read: 0 })])).toEqual([])
  })

  test("a step after a compaction is new content, not a re-bill", () => {
    expect(scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), { type: "compaction" }, step("b", 1_000, { prompt: 8_000, read: 0, write: 8_000 })])).toEqual([])
  })

  test("a step with no usage still refreshed the cache: the lifetime runs from its start", () => {
    const [miss] = scan([
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }),
      step("interrupted", 4 * MINUTE, undefined),
      step("b", 8 * MINUTE, { prompt: 40_000, read: 0, write: 40_000 }),
    ])
    expect(miss?.sinceRefreshMs).toBe(4 * MINUTE)
    expect(resolve(miss ?? expect.unreachable(), FIVE_MINUTES)?.cause).toEqual({ _tag: "PrefixChanged" })
  })
})

describe("causes", () => {
  test("another model's cache holds nothing of the prefix, whatever the lifetime", () => {
    const timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", 1_000, { prompt: 40_000, read: 0, write: 40_000 }, { model: "anthropic/claude-opus-4-5" })]
    expect(causeOf(timeline)).toEqual({ _tag: "ModelSwitch" })
    expect(scan(timeline).map((miss) => resolve(miss, undefined)?.cause)).toEqual([{ _tag: "ModelSwitch" }])
  })

  test("inside the lifetime, an explicit cache's miss is a changed prefix", () => {
    expect(causeOf([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", MINUTE, { prompt: 40_000, read: 2_000, write: 38_000 })])).toEqual({ _tag: "PrefixChanged" })
  })

  test("inside the lifetime, an implicit cache's miss is no evidence: it does not count", () => {
    const openai = { model: "openai/gpt-5.5" }
    const found = scan([step("a", 0, { prompt: 40_000, read: 30_000 }, openai), step("b", MINUTE, { prompt: 40_000, read: 0 }, openai)])
    expect(found).toHaveLength(1)
    expect(found.map((miss) => resolve(miss, 30 * MINUTE))).toEqual([undefined])
    // Past the lifetime it counts as an expiry.
    expect(found.map((miss) => resolve(miss, 30_000)?.cause._tag)).toEqual(["Paused"])
  })

  test("with no lifetime only a model switch counts", () => {
    const found = scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", 10 * MINUTE, { prompt: 40_000, read: 0, write: 40_000 })])
    expect(found).toHaveLength(1)
    expect(found.map((miss) => resolve(miss, undefined))).toEqual([undefined])
  })

  test("the previous response took most of the lifetime", () => {
    const timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { endedAt: 5 * MINUTE }), step("b", 6 * MINUTE, { prompt: 40_000, read: 0, write: 40_000 })]
    expect(causeOf(timeline)).toEqual({ _tag: "Response", ms: 5 * MINUTE })
  })

  test("a tool call that took at least half the gap, in one turn: the longest one", () => {
    const tools = [
      { name: "read", at: 3_000, ms: 1_000 },
      { name: "shell", at: 4_000, ms: 6 * MINUTE },
    ]
    const timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { tools }), step("b", 7 * MINUTE, { prompt: 41_000, read: 0, write: 41_000 })]
    expect(causeOf(timeline)).toEqual({ _tag: "Tool", toolName: "shell", ms: 6 * MINUTE })
  })

  test("an approval wait inside the gap names the wait, before the tool call that held it", () => {
    const timeline = [
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { tools: [{ name: "shell", at: 3_000, ms: 6 * MINUTE }] }),
      step("b", 7 * MINUTE, { prompt: 41_000, read: 0, write: 41_000 }),
    ]
    expect(causeOf(timeline, FIVE_MINUTES, [{ name: "approval", at: 4_000, ms: 6 * MINUTE }])).toEqual({ _tag: "Approval", ms: 6 * MINUTE })
    // A wait outside the gap is another one's.
    expect(causeOf(timeline, FIVE_MINUTES, [{ name: "approval", at: 8 * MINUTE, ms: 6 * MINUTE }])).toEqual({ _tag: "Tool", toolName: "shell", ms: 6 * MINUTE })
  })

  test("nothing in a turn that took half the gap: the turn paused", () => {
    const timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { tools: [{ name: "read", at: 3_000, ms: MINUTE }] }), step("b", 7 * MINUTE, { prompt: 41_000, read: 0, write: 41_000 })]
    expect(causeOf(timeline)).toEqual({ _tag: "Paused", ms: 7 * MINUTE })
  })

  test("a new turn a subagent's report opened, after the lifetime", () => {
    const timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), step("b", 9 * MINUTE, { prompt: 41_000, read: 0, write: 41_000 }, { opener: { id: "msg_report", kind: "subagent" } })]
    expect(causeOf(timeline)).toEqual({ _tag: "Child", ms: 9 * MINUTE })
  })

  test("any other new turn after the lifetime is idle time, even with a long tool call before it", () => {
    const timeline = [
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { tools: [{ name: "shell", at: 3_000, ms: 8 * MINUTE }] }),
      step("b", 9 * MINUTE, { prompt: 41_000, read: 0, write: 41_000 }, { opener: { id: "msg_next", kind: "prompt" } }),
    ]
    expect(causeOf(timeline)).toEqual({ _tag: "Idle", ms: 9 * MINUTE })
  })
})

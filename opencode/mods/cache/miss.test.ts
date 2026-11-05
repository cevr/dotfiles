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
  options: { model?: string; opener?: Opener; tools?: ReadonlyArray<Span>; endedAt?: number; agent?: string; login?: string; compaction?: true } = {},
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
  ...(options.agent === undefined ? {} : { agent: options.agent }),
  ...(options.login === undefined ? {} : { login: options.login }),
  ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
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

  test("the first step to report after a compaction is marked: its prefix is the summary", () => {
    const found = scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), { type: "compaction" }, step("b", 1_000, { prompt: 8_000, read: 0, write: 8_000 })])
    expect(found.map((miss) => [miss.stepID, miss.missedTokens, miss.compaction])).toEqual([["b", 8_000, "after"]])
  })

  test("a compaction's summary request is a request: the step after it times from it and reads its cache", () => {
    const found = scan([
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { agent: "build" }),
      step("summary", MINUTE, { prompt: 41_000, read: 40_000, write: 1_000 }, { compaction: true }),
      { type: "compaction" },
      step("b", 2 * MINUTE, { prompt: 6_000, read: 0, write: 6_000 }, { agent: "build" }),
    ])
    expect(found.map((miss) => [miss.stepID, miss.sinceRefreshMs, miss.compaction])).toEqual([["b", MINUTE, "after"]])
  })

  test("a miss names the agent of the request it is timed from", () => {
    const [miss] = scan([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { agent: "worker" }), step("b", MINUTE, { prompt: 40_000, read: 0, write: 40_000 }, { agent: "build" })])
    expect(miss?.agent).toBe("worker")
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

  test("inside the lifetime, the step after a compaction re-read the new summary, not a changed prefix", () => {
    const timeline: Timeline = [step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }), { type: "compaction" }, step("b", MINUTE, { prompt: 8_000, read: 0, write: 8_000 })]
    expect(causeOf(timeline)).toEqual({ _tag: "Compaction", request: false })
    // Past the lifetime the lapse says why.
    expect(causeOf(timeline, 30_000)).toEqual({ _tag: "Paused", ms: MINUTE })
  })

  test("inside the lifetime, a compaction's summary request that missed the cached conversation", () => {
    const timeline: Timeline = [
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }),
      step("summary", MINUTE, { prompt: 41_000, read: 0, write: 41_000 }, { compaction: true }),
      { type: "compaction" },
      step("b", 2 * MINUTE, { prompt: 6_000, read: 0, write: 6_000 }),
    ]
    expect(scan(timeline).map((miss) => [miss.stepID, resolve(miss, FIVE_MINUTES)?.cause])).toEqual([
      ["summary", { _tag: "Compaction", request: true }],
      ["b", { _tag: "Compaction", request: false }],
    ])
  })

  test("inside the lifetime, a step the pool sent on another login than the cached one", () => {
    const timeline = [
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { login: "cred_1" }),
      step("b", MINUTE, { prompt: 40_000, read: 0, write: 40_000 }, { login: "cred_2" }),
    ]
    expect(causeOf(timeline)).toEqual({ _tag: "LoginMoved" })
    // The login moved across a compaction: the move is the cause named.
    expect(causeOf([timeline[0] ?? expect.unreachable(), { type: "compaction" }, timeline[1] ?? expect.unreachable()])).toEqual({ _tag: "LoginMoved" })
    // Past the lifetime the cache was gone on either login: the lapse says why.
    expect(causeOf(timeline, 30_000)).toEqual({ _tag: "Paused", ms: MINUTE })
    // A step whose login the pool did not record is no evidence of a move.
    expect(causeOf([step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { login: "cred_1" }), step("b", MINUTE, { prompt: 40_000, read: 0, write: 40_000 })])).toEqual({
      _tag: "PrefixChanged",
    })
  })

  test("a model switch outranks a login move", () => {
    const timeline = [
      step("a", 0, { prompt: 40_000, read: 0, write: 40_000 }, { login: "cred_1" }),
      step("b", MINUTE, { prompt: 40_000, read: 0, write: 40_000 }, { login: "cred_2", model: "anthropic/claude-opus-4-5" }),
    ]
    expect(causeOf(timeline)).toEqual({ _tag: "ModelSwitch" })
  })
})

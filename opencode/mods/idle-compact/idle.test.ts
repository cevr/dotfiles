import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Decision, due, type Facts, type LastRequest, type Policy, thresholdOf } from "./idle.ts"
import type { Price } from "./price.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const POLICY: Policy = { ttl: Option.none(), margins: { short: MINUTE, long: 5 * MINUTE }, ratio: 0.3, cap: 60_000, subagents: false }

const request = (fields: Partial<LastRequest> = {}): LastRequest => ({
  startedAt: 0,
  prompt: 100_000,
  cached: true,
  ttl: Option.some(5 * MINUTE),
  window: Option.some(1_000_000),
  ...fields,
})

const facts = (fields: Partial<Facts> = {}, last: Partial<LastRequest> = {}): Facts => ({
  child: false,
  running: false,
  busy: [],
  last: Option.some(request(last)),
  compacted: false,
  onSummary: false,
  ...fields,
})

const reason = (decision: Decision) => (decision._tag === "Skip" ? decision.reason : undefined)
const at = (decision: Decision) => (decision._tag === "Due" ? decision.at : undefined)

describe("when an idle session compacts", () => {
  test("a five-minute cache: one minute before it expires, counted from the request's start", () => {
    const decision = due(facts({}, { startedAt: 1_000 }), 2_000, POLICY)
    expect(decision).toEqual(Decision.Due({ at: 1_000 + 4 * MINUTE, expiresAt: 1_000 + 5 * MINUTE, ttl: 5 * MINUTE, prompt: 100_000, threshold: 60_000 }))
  })

  test("an hour's cache: five minutes before it expires", () => {
    expect(at(due(facts({}, { ttl: Option.some(HOUR) }), 0, POLICY))).toBe(55 * MINUTE)
  })

  test("the margins are the policy's, and a margin longer than the cache means at once", () => {
    const policy = { ...POLICY, margins: { short: 5_000, long: 10 * MINUTE } }
    expect(at(due(facts({}, { ttl: Option.some(20_000) }), 0, policy))).toBe(15_000)
    expect(at(due(facts({}, { ttl: Option.some(HOUR) }), 0, policy))).toBe(50 * MINUTE)
    expect(at(due(facts({}, { startedAt: 100, ttl: Option.some(20_000) }), 0, { ...policy, margins: { short: 30_000, long: 0 } }))).toBe(100)
  })

  test("the policy's ttl overrides the provider's, and stands in for an unknown one", () => {
    const policy = { ...POLICY, ttl: Option.some(20_000), margins: { short: 5_000, long: 5 * MINUTE } }
    expect(at(due(facts(), 0, policy))).toBe(15_000)
    expect(at(due(facts({}, { ttl: Option.none() }), 0, policy))).toBe(15_000)
  })

  test("past the due time but before expiry it is due now", () => {
    const decision = due(facts(), 4.5 * MINUTE, POLICY)
    expect(decision._tag).toBe("Due")
    expect(at(decision)).toBeLessThan(4.5 * MINUTE)
  })

  test("the threshold is 30% of the window or 60k, whichever is smaller; 60k when the window is unknown", () => {
    expect(thresholdOf(Option.some(1_000_000), POLICY)).toBe(60_000)
    expect(thresholdOf(Option.some(128_000), POLICY)).toBe(38_400)
    expect(thresholdOf(Option.none(), POLICY)).toBe(60_000)
    expect(reason(due(facts({}, { prompt: 60_000 }), 0, POLICY))).toBe("too-small")
    expect(due(facts({}, { prompt: 60_001 }), 0, POLICY)._tag).toBe("Due")
    expect(reason(due(facts({}, { prompt: 38_400, window: Option.some(128_000) }), 0, POLICY))).toBe("too-small")
    expect(due(facts({}, { prompt: 40_000, window: Option.some(128_000) }), 0, POLICY)._tag).toBe("Due")
    expect(reason(due(facts({}, { prompt: 90_000 }), 0, { ...POLICY, cap: 100_000 }))).toBe("too-small")
  })

  test("never while an execution runs, a foreground subagent's included, or for a subagent's own session", () => {
    expect(reason(due(facts({ running: true }), 0, POLICY))).toBe("running")
    // A foreground subagent is its parent's running tool call: the parent runs, whatever else runs beside it.
    expect(reason(due(facts({ running: true, busy: ["subagent reviewer"] }), 0, POLICY))).toBe("running")
    expect(reason(due(facts({ child: true }), 0, POLICY))).toBe("subagent-session")
    expect(due(facts({ child: true }), 0, { ...POLICY, subagents: true })._tag).toBe("Due")
  })

  test("background subagents and jobs do not hold an idle session back: it is due as if none ran", () => {
    // Their notice would wake the session after the cache expired; a notice that comes first cancels the timer instead.
    const background = ["subagent reviewer", "shell codex-bridge wait"]
    expect(due(facts({ busy: background }, { ttl: Option.some(HOUR) }), 0, POLICY)).toEqual(due(facts({}, { ttl: Option.some(HOUR) }), 0, POLICY))
    expect(at(due(facts({ busy: background }, { ttl: Option.some(HOUR) }), 0, POLICY))).toBe(55 * MINUTE)
  })

  test("never twice for one cache, and not before a first request", () => {
    expect(reason(due(facts({ compacted: true }), 0, POLICY))).toBe("compacted")
    expect(reason(due(facts({ last: Option.none() }), 0, POLICY))).toBe("no-request")
  })

  test("not without cache information: no lifetime known, or a request the provider did not cache", () => {
    expect(reason(due(facts({}, { ttl: Option.none() }), 0, POLICY))).toBe("no-cache")
    expect(reason(due(facts({}, { cached: false }), 0, POLICY))).toBe("no-cache")
  })

  test("not once the cache has expired: compacting would write it all again", () => {
    expect(reason(due(facts(), 5 * MINUTE, POLICY))).toBe("expired")
    expect(reason(due(facts({}, { ttl: Option.some(HOUR) }), 2 * HOUR, POLICY))).toBe("expired")
  })

  test("not again until new work: the first request on top of a compaction's summary is none", () => {
    // Whatever made the compaction, idle, automatic or manual: the context starts at it, and the summary's own request is no request of the session's.
    expect(reason(due(facts({ onSummary: true }, { prompt: 150_000 }), 0, POLICY))).toBe("no-new-work")
    expect(due(facts({ onSummary: false }, { prompt: 150_000 }), 0, POLICY)._tag).toBe("Due")
  })

  test("only when compacting costs less than the next request writing the whole prompt again", () => {
    // Opus 5.5 as the catalog prices it; Anthropic bills the one-hour write at twice the input rate.
    const opus: Price = { rates: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }], anthropic: true }
    const hour = { ttl: Option.some(HOUR), price: opus }
    // Break-even on an hour's cache: (32k * $20 + 64k * $8) / ($8 - $0.20) = 147,693 tokens.
    expect(reason(due(facts({}, { ...hour, prompt: 147_692 }), 0, POLICY))).toBe("costs-more")
    expect(at(due(facts({}, { ...hour, prompt: 147_693 }), 0, POLICY))).toBe(55 * MINUTE)
    // A five-minute write costs less to let expire: (32k * $20 + 64k * $5) / ($5 - $0.20) = 200k.
    expect(reason(due(facts({}, { price: opus, prompt: 200_000 }), 0, POLICY))).toBe("costs-more")
    expect(due(facts({}, { price: opus, prompt: 200_001 }), 0, POLICY)._tag).toBe("Due")
    // The policy's lifetime decides when, the request's what its write was billed at.
    expect(reason(due(facts({}, { price: opus, prompt: 160_000 }), 0, { ...POLICY, ttl: Option.some(HOUR) }))).toBe("costs-more")
  })

  test("a provider that bills no cache writes bills a rewritten prompt as input; an unpriced model compacts on the threshold alone", () => {
    const gpt: Price = { rates: [{ input: 2, output: 16, cacheRead: 0.2, cacheWrite: 0 }], anthropic: false }
    // (32k * $16 + 64k * $2) / ($2 - $0.20) = 355,556 tokens.
    expect(reason(due(facts({}, { price: gpt, prompt: 355_555 }), 0, POLICY))).toBe("costs-more")
    expect(due(facts({}, { price: gpt, prompt: 355_556 }), 0, POLICY)._tag).toBe("Due")
    const free: Price = { rates: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }], anthropic: false }
    expect(due(facts({}, { price: free, prompt: 60_001 }), 0, POLICY)._tag).toBe("Due")
    expect(due(facts({}, { prompt: 60_001 }), 0, POLICY)._tag).toBe("Due")
  })
})

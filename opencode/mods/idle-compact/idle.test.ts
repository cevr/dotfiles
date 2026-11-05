import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Decision, due, type Facts, type LastRequest, type Policy, thresholdOf } from "./idle.ts"

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

  test("never while an execution runs, a subagent or background job runs, or for a subagent's own session", () => {
    expect(reason(due(facts({ running: true }), 0, POLICY))).toBe("running")
    expect(reason(due(facts({ busy: ["subagent reviewer"] }), 0, POLICY))).toBe("busy")
    expect(reason(due(facts({ child: true }), 0, POLICY))).toBe("subagent-session")
    expect(due(facts({ child: true }), 0, { ...POLICY, subagents: true })._tag).toBe("Due")
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
})

import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Apply, atCompaction, atWake, type CacheFacts, endedBy, KEY, parseRef, type Pending, pendingOf, present, queue, Queueing, withPending } from "./pending.ts"

const OLD = { providerID: "sim", id: "old" }
const NEW = { providerID: "other", id: "new" }
const PENDING: Pending = { sessionID: "ses_a", model: NEW, from: OLD, queuedAt: 0 }
const TTL = 300_000
const GRACE = 60_000
const policy = { ttl: Option.none<number>(), grace: GRACE }
const cached = (startedAt: number, extra: Partial<CacheFacts> = {}): CacheFacts => ({
  last: Option.some({ startedAt, cached: true, ttl: Option.some(TTL), unresolved: Option.none() }),
  compacted: false,
  ...extra,
})
const entry = { variants: ["high"], native: false }

describe("the value in the session's metadata", () => {
  test("is read only for the session it names: a child's copy of its parent's is absent", () => {
    expect(pendingOf("ses_a", Option.some({ [KEY]: PENDING }))).toEqual(Option.some(PENDING))
    expect(pendingOf("ses_child", Option.some({ [KEY]: PENDING }))).toEqual(Option.none())
    expect(pendingOf("ses_a", Option.some({ [KEY]: { sessionID: "ses_a" } }))).toEqual(Option.none())
    expect(pendingOf("ses_a", Option.none())).toEqual(Option.none())
  })

  test("is set and taken out with every other key kept", () => {
    const set = withPending(Option.some({ latch: { id: "l1" }, other: 2 }), Option.some(PENDING))
    expect(set).toEqual({ latch: { id: "l1" }, other: 2, [KEY]: PENDING })
    expect(withPending(Option.some(set), Option.none())).toEqual({ latch: { id: "l1" }, other: 2 })
  })
})

describe("queueing", () => {
  const facts = { current: Option.some(OLD), target: Option.some(entry), own: Option.some({ variants: [], native: false }) }
  test("keeps the target with the model it was queued from", () => {
    expect(queue("ses_a", NEW, facts, 5)).toEqual(Queueing.Keep({ pending: { sessionID: "ses_a", model: NEW, from: OLD, queuedAt: 5 } }))
  })
  test("refuses with why", () => {
    expect(queue("ses_a", NEW, { ...facts, current: Option.none() }, 0)).toMatchObject({ reason: "no-session" })
    expect(queue("ses_a", { ...OLD, variant: "default" }, facts, 0)).toMatchObject({ reason: "same-model" })
    expect(queue("ses_a", NEW, { ...facts, target: Option.none() }, 0)).toMatchObject({ reason: "unknown-model" })
    expect(queue("ses_a", { ...NEW, variant: "max" }, facts, 0)).toMatchObject({ reason: "unknown-model" })
    expect(queue("ses_a", NEW, { ...facts, own: Option.some({ variants: [], native: true }) }, 0)).toMatchObject({ reason: "native-compaction" })
  })
  test("takes a variant the model offers", () => {
    expect(queue("ses_a", { ...NEW, variant: "high" }, facts, 0)._tag).toBe("Keep")
  })
})

describe("a model selection", () => {
  test("ends it when it moves the session off the model it was queued from, not when it selects that model again", () => {
    expect(endedBy(PENDING, NEW)).toBe(true)
    expect(endedBy(PENDING, { providerID: "sim", id: "third" })).toBe(true)
    expect(endedBy(PENDING, { ...OLD, variant: "default" })).toBe(false)
  })
})

describe("at a completed compaction", () => {
  test("switches, unless the catalog lost the target", () => {
    expect(atCompaction(PENDING, true)._tag).toBe("Switch")
    expect(atCompaction(PENDING, false)).toEqual(Apply.Wait({ reason: "target-gone" }))
    expect(present(NEW, Option.none())).toBe(false)
  })
})

describe("at a wake", () => {
  test("never early: inside the lifetime, at its end and inside the grace it waits", () => {
    for (const now of [TTL - 5_000, TTL, TTL + GRACE - 5_000, TTL + GRACE]) expect(atWake(PENDING, cached(0), policy, true, now)).toMatchObject({ reason: "warm" })
  })
  test("past the lifetime plus the grace it switches", () => {
    expect(atWake(PENDING, cached(0), policy, true, TTL + GRACE + 1)._tag).toBe("Switch")
  })
  test("every unknown waits", () => {
    const late = 24 * 3_600_000
    expect(atWake(PENDING, { last: Option.none(), compacted: false }, policy, true, late)).toMatchObject({ reason: "no-request" })
    expect(atWake(PENDING, cached(0, { compacted: true }), policy, true, late)).toMatchObject({ reason: "compacted" })
    expect(atWake(PENDING, { last: Option.some({ startedAt: 0, cached: false, ttl: Option.some(TTL), unresolved: Option.none() }), compacted: false }, policy, true, late)).toMatchObject({ reason: "uncached" })
    expect(atWake(PENDING, { last: Option.some({ startedAt: 0, cached: true, ttl: Option.none(), unresolved: Option.none() }), compacted: false }, policy, true, late)).toMatchObject({ reason: "ttl-unknown" })
    expect(
      atWake(PENDING, { last: Option.some({ startedAt: 0, cached: true, ttl: Option.some(TTL), unresolved: Option.some("the catalog cannot be read") }), compacted: false }, policy, true, late),
    ).toMatchObject({ reason: "ttl-unknown" })
    expect(atWake(PENDING, cached(0), policy, false, late)).toMatchObject({ reason: "target-gone" })
  })
  test("the policy's lifetime is over the request's", () => {
    const hour = { ttl: Option.some(3_600_000), grace: GRACE }
    expect(atWake(PENDING, cached(0), hour, true, TTL + GRACE + 1)).toMatchObject({ reason: "warm" })
  })
})

describe("a reference as the tool takes it", () => {
  test("reads provider/id and an optional #variant", () => {
    expect(parseRef("anthropic/claude-fable-5-2")).toEqual(Option.some({ providerID: "anthropic", id: "claude-fable-5-2" }))
    expect(parseRef("anthropic/claude-fable-5-2#high")).toEqual(Option.some({ providerID: "anthropic", id: "claude-fable-5-2", variant: "high" }))
    expect(parseRef("claude-fable-5-2")).toEqual(Option.none())
  })
})

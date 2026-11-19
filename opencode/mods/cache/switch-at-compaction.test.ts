// A model switch the old model's cache could not have served is not a model
// switch's miss: on the first request after a compaction the prefix is the new
// summary whichever model reads it, and past the cache's lifetime the old
// cache had expired. A queued switch (mods/model-next) lands on exactly those.
//
// The law, for each of the three judges: such a request, sent on another model
// than the request before it, is judged exactly as the same request would be
// on the same model. Controls: a switch inside the lifetime anywhere else, and
// a summary request on another model, stay model switches.
import { describe, expect, test } from "bun:test"
import { classify } from "./audit.ts"
import { segments } from "./fingerprint.ts"
import { resolve, scan, type Scanned, type Step, type Timeline } from "./miss.ts"
import { judge, type LedgerLine, type Previous, type Sent } from "./request-log.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OLD = "anthropic/claude-old"
const NEW = "anthropic/claude-new"

/** A seeded generator (mulberry32): the same cases on every run. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const CASES = 500

describe("miss.ts resolve: the step after a compaction", () => {
  test("on another model it is judged as on the same model, over lifetimes, gaps, caches and logins", () => {
    const next = random(1)
    const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)] as A
    for (let index = 0; index < CASES; index += 1) {
      const scanned: Scanned = {
        stepID: `step_${index}`,
        startedAt: 1_000_000,
        model: NEW,
        missedTokens: 1_025 + Math.floor(next() * 80_000),
        usage: { promptTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: pick([0, 60_000]) },
        sinceRefreshMs: Math.floor(next() * 2 * HOUR),
        modelSwitch: true,
        explicitCache: pick([true, false]),
        compaction: "after",
        loginMoved: pick([true, false]),
        lapse: { _tag: "Idle", ms: 0 },
      }
      const lifetime = pick([undefined, 5 * MINUTE, HOUR])
      expect(resolve(scanned, lifetime)).toEqual(resolve({ ...scanned, modelSwitch: false }, lifetime))
    }
  })

  test("a switch anywhere else is still a model switch: mid-conversation, and on a compaction's own summary request", () => {
    const base: Scanned = {
      stepID: "step",
      startedAt: 1_000_000,
      model: NEW,
      missedTokens: 50_000,
      usage: { promptTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 90_000 },
      sinceRefreshMs: MINUTE,
      modelSwitch: true,
      explicitCache: true,
      loginMoved: false,
      lapse: { _tag: "Idle", ms: 0 },
    }
    expect(resolve(base, HOUR)?.cause).toEqual({ _tag: "ModelSwitch" })
    expect(resolve({ ...base, compaction: "request" }, HOUR)?.cause).toEqual({ _tag: "ModelSwitch" })
  })

  test("a session's timeline: old model, its summary request, the compaction, then the new model writes the summary", () => {
    const step = (id: string, at: number, model: string, usage: { prompt: number; read: number; write: number }, compaction?: true): Step => ({
      type: "step",
      id,
      model,
      startedAt: at,
      endedAt: at + 2_000,
      usage: { promptTokens: usage.prompt, cacheReadTokens: usage.read, cacheWriteTokens: usage.write },
      tools: [],
      opener: { id: "msg_prompt", kind: "prompt" },
      closes: false,
      ...(compaction === undefined ? {} : { compaction }),
    })
    const timeline: Timeline = [
      step("a", 0, OLD, { prompt: 292_000, read: 0, write: 292_000 }),
      step("summary", MINUTE, OLD, { prompt: 292_500, read: 292_000, write: 500 }, true),
      { type: "compaction" },
      step("b", 2 * MINUTE, NEW, { prompt: 64_000, read: 0, write: 64_000 }),
    ]
    const found = scan(timeline)
    expect(found.map((miss) => miss.stepID)).toEqual(["b"])
    expect(found.map((miss) => resolve(miss, HOUR)?.cause)).toEqual([{ _tag: "Compaction", request: false }])
  })
})

describe("miss.ts resolve: a switch past the cache's lifetime", () => {
  test("on another model it is judged as on the same model: the lapse's, wherever it lands", () => {
    const next = random(3)
    const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)] as A
    for (let index = 0; index < CASES; index += 1) {
      const lifetime = pick([5 * MINUTE, HOUR])
      const scanned: Scanned = {
        stepID: `step_${index}`,
        startedAt: 1_000_000,
        model: NEW,
        missedTokens: 1_025 + Math.floor(next() * 80_000),
        usage: { promptTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: pick([0, 60_000]) },
        sinceRefreshMs: lifetime + 1 + Math.floor(next() * 2 * HOUR),
        modelSwitch: true,
        explicitCache: pick([true, false]),
        loginMoved: pick([true, false]),
        lapse: pick([{ _tag: "Idle", ms: 0 } as const, { _tag: "Paused", ms: 0 } as const, { _tag: "Child", ms: 0 } as const]),
        ...pick([{}, { compaction: "request" as const }, { compaction: "after" as const }]),
      }
      const resolved = resolve(scanned, lifetime)
      expect(resolved).toEqual(resolve({ ...scanned, modelSwitch: false }, lifetime))
      expect(resolved?.cause).toEqual(scanned.lapse)
    }
  })

  test("with no lifetime known, or inside it, a switch is still a model switch", () => {
    const base: Scanned = {
      stepID: "step",
      startedAt: 1_000_000,
      model: NEW,
      missedTokens: 50_000,
      usage: { promptTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 90_000 },
      sinceRefreshMs: 2 * HOUR,
      modelSwitch: true,
      explicitCache: true,
      loginMoved: false,
      lapse: { _tag: "Idle", ms: 2 * HOUR },
    }
    expect(resolve(base, undefined)?.cause).toEqual({ _tag: "ModelSwitch" })
    expect(resolve({ ...base, sinceRefreshMs: HOUR }, HOUR)?.cause).toEqual({ _tag: "ModelSwitch" })
  })
})

describe("request-log.ts judge: the first request after a compaction", () => {
  const prompt = (text: string) => ({ system: [{ type: "text", text: `Rules.\n\n${"rules ".repeat(500)}` }], messages: [{ role: "user", content: text }] })
  const sent = (at: number, fields: Partial<Sent> = {}): Sent => ({ at, kind: "primary", agent: "build", model: OLD, ttlMs: HOUR, segments: segments(prompt("Summary.")), ...fields })
  const before: Previous = { sent: sent(0, { kind: "compaction", segments: segments(prompt("The long conversation.")) }), tokens: { prompt: 292_500, read: 292_000, write: 500 } }

  test("on another model it is judged as on the same model, over gaps and reads", () => {
    const next = random(2)
    for (let index = 0; index < CASES; index += 1) {
      const at = Math.floor(next() * 2 * HOUR)
      const read = Math.floor(next() * 64_000)
      const tokens = { prompt: 64_000, read, write: 64_000 - read }
      expect(judge(before, sent(at, { model: NEW }), tokens, true)).toEqual(judge(before, sent(at), tokens, true))
    }
  })

  test("inside the lifetime that is `compaction`, and without a compaction between it stays `model`", () => {
    const tokens = { prompt: 64_000, read: 0, write: 64_000 }
    expect(judge(before, sent(MINUTE, { model: NEW }), tokens, true).cause).toBe("compaction")
    const plain: Previous = { sent: sent(0), tokens: { prompt: 292_000, read: 0, write: 292_000 } }
    expect(judge(plain, sent(MINUTE, { model: NEW }), tokens, false).cause).toBe("model")
  })

  test("a summary request on another model than the conversation's is a model switch: it wrote the long prefix", () => {
    const plain: Previous = { sent: sent(0), tokens: { prompt: 292_000, read: 0, write: 292_000 } }
    expect(judge(plain, sent(MINUTE, { kind: "compaction", model: NEW }), { prompt: 292_500, read: 0, write: 292_500 }, false).cause).toBe("model")
  })

  test("past the lifetime a switch is judged as on the same model, `expired`, a summary request too", () => {
    const next = random(4)
    const plain: Previous = { sent: sent(0, { ttlMs: 5 * MINUTE }), tokens: { prompt: 292_000, read: 0, write: 292_000 } }
    for (let index = 0; index < CASES; index += 1) {
      const at = 5 * MINUTE + 1 + Math.floor(next() * 2 * HOUR)
      const kind = next() < 0.5 ? "primary" : "compaction"
      const compacted = next() < 0.5
      const tokens = { prompt: 292_000, read: 0, write: 292_000 }
      const switched = judge(plain, sent(at, { model: NEW, kind }), tokens, compacted)
      expect(switched).toEqual(judge(plain, sent(at, { kind }), tokens, compacted))
      expect(switched.cause).toBe("expired")
    }
  })
})

describe("audit.ts classify: a break on the first request after a compaction", () => {
  const row = (at: number, fields: Partial<LedgerLine> = {}): LedgerLine => ({
    at,
    host: "mac",
    sessionID: "ses_a",
    kind: "primary",
    agent: "build",
    model: OLD,
    login: "pool:one",
    ttlMs: HOUR,
    prompt: 292_000,
    read: 291_000,
    write: 1_000,
    cause: "hit",
    ...fields,
  })

  test("on another model it is the compaction's break, by either mark of the compaction", () => {
    const after = { model: NEW, prompt: 64_000, read: 0, write: 64_000 }
    expect(classify(row(0, { kind: "compaction" }), row(MINUTE, { ...after, cause: "model" }))).toBe("compaction")
    expect(classify(row(0), row(MINUTE, { ...after, cause: "compaction" }))).toBe("compaction")
  })

  test("a switch with no compaction before it, and a summary request on another model, stay model switches", () => {
    expect(classify(row(0), row(MINUTE, { model: NEW, read: 0, write: 292_000, cause: "model" }))).toBe("model-switch")
    expect(classify(row(0), row(MINUTE, { kind: "compaction", model: NEW, read: 0, write: 292_000, cause: "model" }))).toBe("model-switch")
  })

  test("past the lifetime a switch is the expiry's break, an old line the server judged `model` too", () => {
    const late = { model: NEW, read: 0, write: 292_000 }
    expect(classify(row(0), row(HOUR + MINUTE, { ...late, cause: "model" }))).toBe("ttl-expiry")
    expect(classify(row(0), row(HOUR + MINUTE, { ...late, cause: "expired" }))).toBe("ttl-expiry")
    expect(classify(row(0, { ttlMs: 5 * MINUTE }), row(6 * MINUTE, { ...late, cause: "expired" }))).toBe("ttl-expiry")
  })
})

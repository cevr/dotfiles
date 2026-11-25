// Google's quota answers as the pool's Antigravity windows: T3 Code's test
// shapes (antigravityUsageLimits.test.ts at 55085df2) as a table, then
// generated bodies, which never throw and whose excess fields change nothing.
import { describe, expect, test } from "bun:test"
import { Array as Arr, DateTime, Option, type Schema } from "effect"
import { decodeModels, decodeSummary, firstAnswers, type Models, modelWindows, type Summary, summaryWindows, type Window } from "./quota.ts"

const at = (iso: string) => Date.parse(iso)
const summary = (decoded: Option.Option<Summary>, requestedAt: number) => Option.match(decoded, { onNone: () => [], onSome: (read) => summaryWindows(read, requestedAt) })
const models = (decoded: Option.Option<Models>) => Option.match(decoded, { onNone: () => [], onSome: modelWindows })
const brief = (windows: ReadonlyArray<Window>) => windows.map((window) => [window.group, window.span, Math.round(window.used * 1000) / 1000, Option.fromUndefinedOr(window.resetAt)])

describe("Antigravity quota summary", () => {
  test("the two groups' 5-hour and weekly buckets read as their windows", () => {
    const body = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.96, resetTime: "2026-10-12T19:41:43Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.91, resetTime: "2026-10-09T16:06:01Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0, resetTime: "2026-10-10T15:28:22Z" },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 0.44, resetTime: "2026-10-09T16:06:30Z" },
          ],
        },
      ],
    }
    expect(brief(summary(decodeSummary(body), at("2026-10-09T12:00:00Z")))).toEqual([
      ["gemini", "7d", 0.04, Option.some(at("2026-10-12T19:41:43Z"))],
      ["gemini", "5h", 0.09, Option.some(at("2026-10-09T16:06:01Z"))],
      ["claude-gpt", "7d", 1, Option.some(at("2026-10-10T15:28:22Z"))],
      ["claude-gpt", "5h", 0.56, Option.some(at("2026-10-09T16:06:30Z"))],
    ])
  })

  test("an untouched bucket's rolling reset is no reset; a used, described, spent or overfull one keeps its reset", () => {
    const requestedAt = at("2026-10-21T10:16:04Z")
    const body = {
      groups: [
        {
          buckets: [
            { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-10-21T15:16:05Z" },
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T10:16:05Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.848104, resetTime: "2026-10-21T13:29:53Z", description: "You have used some of your 5-hour limit." },
          ],
        },
      ],
    }
    expect(brief(summary(decodeSummary(body), requestedAt))).toEqual([
      ["claude-gpt", "5h", 0, Option.none()],
      ["claude-gpt", "7d", 0, Option.none()],
      ["gemini", "5h", 0.152, Option.some(at("2026-10-21T13:29:53Z"))],
    ])
    const kept = {
      buckets: [
        { bucketId: "described", window: "5h", remainingFraction: 1, description: "Reported reset", resetTime: "2026-10-21T15:16:04Z" },
        { bucketId: "distant", window: "weekly", remainingFraction: 1, resetTime: "2026-10-28T12:16:04Z" },
        { bucketId: "spent", window: "5h", remainingFraction: 0, resetTime: "2026-10-21T15:16:04Z" },
        { bucketId: "overfull", window: "5h", remainingFraction: 1.01, resetTime: "2026-10-21T15:16:04Z" },
        { bucketId: "empty-description", window: "5h", remainingFraction: 1, description: "", resetTime: "2026-10-21T15:16:04Z" },
      ],
    }
    expect(summary(decodeSummary(kept), requestedAt).map((window) => [window.group, Option.fromUndefinedOr(window.resetAt)])).toEqual([
      ["described", Option.some(at("2026-10-21T15:16:04Z"))],
      ["distant", Option.some(at("2026-10-28T12:16:04Z"))],
      ["spent", Option.some(at("2026-10-21T15:16:04Z"))],
      ["overfull", Option.some(at("2026-10-21T15:16:04Z"))],
      ["empty-description", Option.some(at("2026-10-21T15:16:04Z"))],
    ])
  })

  test("the 60-second tolerance applies to both lengths", () => {
    const requestedAt = at("2026-10-21T10:16:04Z")
    const bucket = (bucketId: string, window: string, resetTime: string) => ({ bucketId, window, remainingFraction: 1, resetTime })
    const body = {
      buckets: [
        bucket("5h-after", "5h", "2026-10-21T15:17:05Z"),
        bucket("5h-before", "5h", "2026-10-21T15:15:05Z"),
        bucket("5h-edge", "5h", "2026-10-21T15:17:04Z"),
        bucket("weekly-after", "weekly", "2026-10-28T10:17:03Z"),
        bucket("weekly-before", "weekly", "2026-10-28T10:15:03Z"),
        bucket("weekly-edge", "weekly", "2026-10-28T10:15:04Z"),
      ],
    }
    expect(summary(decodeSummary(body), requestedAt).map((window) => [window.group, Option.fromUndefinedOr(window.resetAt)])).toEqual([
      ["5h-after", Option.some(at("2026-10-21T15:17:05Z"))],
      ["5h-before", Option.none()],
      ["5h-edge", Option.none()],
      ["weekly-after", Option.none()],
      ["weekly-before", Option.some(at("2026-10-28T10:15:03Z"))],
      ["weekly-edge", Option.none()],
    ])
  })

  test("Argon and Carbon are their own groups; disabled, fractionless and unrecognised buckets are not read; fractions are clamped", () => {
    const body = {
      groups: [
        {
          displayName: "Argon",
          buckets: [
            { bucketId: "gemini-argon-5h", window: "5h", remainingFraction: 0.5 },
            { bucketId: "gemini-carbon-5h", window: "5h", remainingFraction: -1 },
            { bucketId: "disabled", window: "5h", remainingFraction: 0, disabled: true },
            { bucketId: "missing", window: "5h", resetTime: "2026-10-10T12:00:00Z" },
            { bucketId: "gemini-daily", window: "daily", remainingFraction: 0.1 },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
          ],
        },
      ],
    }
    expect(summary(decodeSummary(body), 0).map((window) => [window.group, window.label, window.span, window.used, Option.fromUndefinedOr(window.resetAt)])).toEqual([
      ["gemini-argon", "Argon", "5h", 0.5, Option.none()],
      ["gemini-carbon", "Argon", "5h", 1, Option.none()],
      ["gemini", "Gemini", "5h", 0, Option.none()],
    ])
  })

  test("the per-model answer: weekly quota as the week, the other as a window of unstated length, the most used model's", () => {
    const body = {
      models: {
        "gemini-a": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" } },
        "gemini-b": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" } },
        "claude-a": { quotaInfo: { remainingFraction: 0.2 }, weeklyQuotaInfo: { remainingFraction: 0.5 } },
        "other-model": { quotaInfo: { remainingFraction: 0 } },
      },
    }
    expect(brief(models(decodeModels(body)))).toEqual([
      ["gemini", "quota", 0.4, Option.some(at("2026-10-10T12:00:00Z"))],
      ["claude-gpt", "quota", 0.8, Option.none()],
      ["claude-gpt", "7d", 0.5, Option.none()],
    ])
  })

  test("the first endpoint to read a window wins it; another endpoint adds only what the first lacks", () => {
    const window = (group: string, span: "5h" | "7d", used: number): Window => ({ group, label: group, span, used })
    expect(brief(firstAnswers([[window("claude-gpt", "5h", 0.5)], [window("claude-gpt", "5h", 0), window("gemini", "7d", 0.1)]]))).toEqual([
      ["claude-gpt", "5h", 0.5, Option.none()],
      ["gemini", "7d", 0.1, Option.none()],
    ])
  })
})

/** A seeded generator: the same seed, the same sequence. */
const generator = (seed: number) => {
  let state = Math.max((seed * 2654435761) >>> 0, 1)
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

type Random = ReturnType<typeof generator>

/** One of `from`, at random. */
const pick = <A,>(random: Random, from: readonly [A, ...ReadonlyArray<A>]): A => Option.getOrElse(Arr.get(from, Math.floor(random() * from.length)), () => from[0])

/** `often()` with chance `p`, else `rarely()`. */
const either = <A,>(random: Random, p: number, often: () => A, rarely: () => A): A =>
  Option.getOrElse(Arr.get([rarely, often], Number(random() < p)), () => rarely)()

const ANYTHING: readonly [Schema.Json, ...ReadonlyArray<Schema.Json>] = [0, -1, 1.5, Number.NaN, "", "5h", "weekly", true, [], {}, { nested: { deep: 1 } }, "2026-10-10T12:00:00Z", "gemini-5h", "3p-weekly"]

describe("Antigravity quota decoding of generated bodies", () => {
  test("never throws, reads only fractions in range, and ignores excess fields", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const random = generator(seed)
      const any = () => pick(random, ANYTHING)
      const bucket = () => {
        const base = {
          bucketId: either(random, 0.8, () => pick(random, ["gemini-5h", "3p-weekly", "gemini-argon-x", "custom"]), any),
          window: either(random, 0.8, () => pick(random, ["5h", "weekly", "daily"]), any),
          remainingFraction: either(random, 0.7, () => random() * 1.4 - 0.2, any),
          resetTime: either(random, 0.7, () => DateTime.formatIso(DateTime.makeUnsafe(1_800_000_000_000 + random() * 1e9)), any),
        }
        const described = either(random, 0.3, () => ({ ...base, description: any() }), () => base)
        return either(random, 0.3, () => ({ ...described, disabled: any() }), () => described)
      }
      const buckets = Arr.makeBy(Math.floor(random() * 6), bucket)
      const record = either<{ readonly groups?: ReadonlyArray<object>; readonly buckets?: ReadonlyArray<object> }>(random, 0.6, () => ({ groups: [{ displayName: any(), buckets }] }), () => ({ buckets }))
      const read = summary(decodeSummary(record), 1_800_000_000_000)
      for (const window of read) {
        expect(window.used).toBeGreaterThanOrEqual(0)
        expect(window.used).toBeLessThanOrEqual(1)
        expect(["5h", "7d"]).toContain(window.span)
        expect(Option.getOrElse(Option.map(Option.fromUndefinedOr(window.resetAt), Number.isFinite), () => true)).toBe(true)
      }
      expect(summary(decodeSummary({ ...record, unrelated: any(), kind: "extra" }), 1_800_000_000_000)).toEqual(read)
      expect(() => summary(decodeSummary(any()), 1_800_000_000_000)).not.toThrow()
      expect(() => models(decodeModels({ models: { [`gemini-${seed}`]: { quotaInfo: bucket(), weeklyQuotaInfo: any(), extra: any() } } }))).not.toThrow()
    }
  })
})

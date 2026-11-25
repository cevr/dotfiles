// Model-based property tests for the merged Antigravity fleet record: generated
// reports from N hosts in any order, duplicated, delayed and partly unreadable.
// Laws proven:
// 1. Commutativity, associativity and idempotence of mergeRecords / mergeAll.
// 2. Of two live readings for one group and window, the worse (higher used) wins.
// 3. A reset is never moved earlier (for readings or limits).
// 4. A limit holds until its reset or until a LATER reading with room.
// 5. A peer that cannot be read is shown stale with its age, never as open.
// 6. Nothing is ever "unlimited" because it is unknown; an unknown or absent
//    window never blocks a start by itself.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Match, Option, Schema } from "effect"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { Report } from "../status.ts"
import {
  type AntigravityReport,
  EMPTY_MERGED,
  fromReport,
  fromStalePeer,
  type LimitEvent,
  mergeAll,
  mergedAnswerAt,
  mergedNextReadAt,
  mergedWindowAt,
  mergeRecords,
  openDecisionAt,
  OpenStatus,
  readingHost,
  resolveGroup,
} from "./fleet.ts"
import type { Span, Window } from "./quota.ts"
import { Answer, Shown } from "./state.ts"
import { mergedStatusLines } from "./text.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse("2026-11-25T00:00:00Z")
const GROUPS = ["gemini", "claude-gpt"] as const
const SPANS: ReadonlyArray<Span> = ["5h", "7d"]
const HOSTS = ["alpha", "bite-cristian", "mac-pro", "studio", "zebra"] as const

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

const pick = <A,>(random: Random, from: readonly [A, ...ReadonlyArray<A>]): A =>
  Option.getOrElse(Arr.get(from, Math.floor(random() * from.length)), () => from[0])

const shuffle = <A,>(random: Random, items: ReadonlyArray<A>): ReadonlyArray<A> => {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = copy[i]!
    copy[i] = copy[j]!
    copy[j] = a
  }
  return copy
}

const genWindows = (random: Random, now: number): ReadonlyArray<Window> =>
  GROUPS.flatMap((group) =>
    SPANS.flatMap((span): ReadonlyArray<Window> => {
      if (random() < 0.3) return []
      const label = Match.value(group).pipe(Match.when("gemini", () => "Gemini"), Match.orElse(() => "Claude & GPT (shared)"))
      const used = Match.value(random() < 0.2).pipe(Match.when(true, () => 1), Match.orElse(() => Math.round(random() * 99) / 100))
      const base = { group, label, span, used }
      if (random() < 0.2) return [base]
      const spanMs = Match.value(span).pipe(Match.when("5h", () => 5 * HOUR), Match.orElse(() => 7 * 24 * HOUR))
      return [{ ...base, resetAt: now + Math.floor(random() * spanMs) - 30 * MINUTE }]
    }),
  )

const genLimits = (random: Random, host: string, now: number): ReadonlyArray<LimitEvent> => {
  const count = Math.floor(random() * 3)
  return Array.from({ length: count }, (_, idx) => {
    const group = pick(random, GROUPS)
    const seenAt = now - Math.floor(random() * 2 * HOUR)
    const base = { group, seenAt, host }
    const withReset = Match.value(random() < 0.8).pipe(
      Match.when(true, () => ({ ...base, resetAt: seenAt + Math.floor(random() * 3 * HOUR) - 10 * MINUTE })),
      Match.orElse(() => base),
    )
    return Match.value(random() < 0.5).pipe(
      Match.when(true, () => ({ ...withReset, key: `id:${host}-${idx}-${seenAt}` })),
      Match.orElse(() => withReset),
    )
  })
}

const genReport = (random: Random, host: string, now: number): AntigravityReport => {
  const at = now - Math.floor(random() * 30 * MINUTE)
  const base: AntigravityReport = {
    host,
    at,
    readableSignIn: random() < 0.6,
    limits: genLimits(random, host, at),
  }
  const withReading = Match.value(random() < 0.7).pipe(
    Match.when(true, () => ({ ...base, reading: { at: at - Math.floor(random() * 10 * MINUTE), host, windows: genWindows(random, at) } })),
    Match.orElse(() => base),
  )
  return Match.value(random() < 0.7).pipe(
    Match.when(true, () => {
      const attemptAt = at - Math.floor(random() * 10 * MINUTE)
      return { ...withReading, attempt: { id: `${host}-${attemptAt}`, at: attemptAt, nextReadAt: attemptAt + 5 * MINUTE, host } }
    }),
    Match.orElse(() => withReading),
  )
}

const genRecord = (random: Random, now: number) => {
  const hostCount = 1 + Math.floor(random() * HOSTS.length)
  const chosen = HOSTS.slice(0, hostCount)
  const pieces = chosen.flatMap((host) => {
    const roll = random()
    if (roll < 0.25) {
      const since = now - Math.floor(random() * 2 * HOUR) - MINUTE
      const seenAt = since - Math.floor(random() * HOUR)
      const last = Match.value(random() < 0.6).pipe(
        Match.when(true, () => ({ lastReport: genReport(random, host, seenAt), seenAt })),
        Match.orElse(() => ({})),
      )
      return [fromStalePeer({ host, since, message: "ssh timed out", ...last })]
    }
    const report = genReport(random, host, now)
    // Delayed/duplicate report from the same host too
    if (roll > 0.75) {
      const delayed = genReport(random, host, now - 15 * MINUTE)
      return [fromReport(report, now), fromReport(delayed, now - 15 * MINUTE)]
    }
    return [fromReport(report, now)]
  })
  return { pieces, merged: mergeAll(pieces) }
}

describe("Antigravity fleet merge laws (property-tested)", () => {
  test("mergeRecords is commutative, associative, and idempotent across N hosts, permutations, duplicates, delays and stale peers", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = generator(seed)
      const now = START + Math.floor(random() * 10 * HOUR)
      const a = genRecord(random, now).merged
      const b = genRecord(random, now).merged
      const c = genRecord(random, now).merged
      // Commutative
      expect(mergeRecords(a, b)).toEqual(mergeRecords(b, a))
      // Associative
      expect(mergeRecords(mergeRecords(a, b), c)).toEqual(mergeRecords(a, mergeRecords(b, c)))
      // Idempotent
      expect(mergeRecords(a, a)).toEqual(a)
      // Identity
      expect(mergeRecords(a, EMPTY_MERGED)).toEqual(a)
      expect(mergeRecords(EMPTY_MERGED, a)).toEqual(a)
      // Permutation & duplication invariance
      const { pieces, merged } = genRecord(random, now)
      const permuted = mergeAll(shuffle(random, pieces))
      const duplicated = mergeAll(shuffle(random, [...pieces, ...pieces]))
      expect(permuted).toEqual(merged)
      expect(duplicated).toEqual(merged)
    }
  }, hangGuard("in-memory"))

const checkMergedWindowLaw = (r1: ReturnType<typeof fromReport>, r2: ReturnType<typeof fromReport>, merged: ReturnType<typeof mergeRecords>, now: number, group: string, span: Span) => {
  const w1 = mergedWindowAt(r1, now, group, span)
  const w2 = mergedWindowAt(r2, now, group, span)
  const wm = mergedWindowAt(merged, now, group, span)
  const known = [w1, w2].flatMap((shown) => Shown.match(shown, { Known: ({ window }) => [window], Unknown: () => [] }))
  if (known.length === 0) {
    expect(wm._tag).toBe("Unknown")
    return
  }
  expect(wm._tag).toBe("Known")
  if (wm._tag === "Known") {
    expect(wm.window.used).toBe(Math.max(...known.map((w) => w.used)))
    const resets = known.flatMap((w) => Option.toArray(Option.fromUndefinedOr(w.resetAt)))
    if (resets.length > 0) expect(wm.window.resetAt).toBe(Math.max(...resets))
  }
}

  test("worse reading wins and a reset is never moved earlier", () => {
    for (let seed = 200; seed <= 350; seed++) {
      const random = generator(seed)
      const now = START + HOUR
      const r1 = fromReport(genReport(random, "mac", now), now)
      const r2 = fromReport(genReport(random, "workbox", now), now)
      const merged = mergeRecords(r1, r2)
      for (const group of GROUPS) {
        for (const span of SPANS) checkMergedWindowLaw(r1, r2, merged, now, group, span)
        const a1 = mergedAnswerAt(r1, now, group)
        const a2 = mergedAnswerAt(r2, now, group)
        const am = mergedAnswerAt(merged, now, group)
        if (a1._tag === "Limited" && a2._tag === "Limited" && am._tag === "Limited") {
          expect(am.until).toBeGreaterThanOrEqual(Math.min(a1.until, a2.until))
        }
      }
      expect(mergedNextReadAt(merged)).toBeGreaterThanOrEqual(mergedNextReadAt(r1))
      expect(mergedNextReadAt(merged)).toBeGreaterThanOrEqual(mergedNextReadAt(r2))
    }
  }, hangGuard("in-memory"))

  test("a limit holds until its reset or until a LATER reading with room; an earlier reading never lifts it", () => {
    const limitAt = START
    const resetAt = START + 2 * HOUR
    const limitReport: AntigravityReport = {
      host: "workbox",
      at: limitAt,
      readableSignIn: false,
      limits: [{ group: "gemini", seenAt: limitAt, resetAt, host: "workbox", key: "id:err-1" }],
    }
    const earlierRoomy: AntigravityReport = {
      host: "mac",
      at: limitAt - MINUTE,
      readableSignIn: true,
      limits: [],
      reading: {
        at: limitAt - MINUTE,
        host: "mac",
        windows: [
          { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: START + 4 * HOUR },
          { group: "gemini", label: "Gemini", span: "7d", used: 0.3, resetAt: START + 24 * HOUR },
        ],
      },
    }
    const withEarlier = mergeAll([fromReport(limitReport, limitAt), fromReport(earlierRoomy, limitAt)])
    // Earlier reading with room does NOT lift the limit
    expect(mergedAnswerAt(withEarlier, limitAt + 10 * MINUTE, "gemini")).toEqual(Answer.cases.Limited.make({ until: resetAt, by: "limit" }))
    // After reset passes, limit no longer holds
    expect(mergedAnswerAt(withEarlier, resetAt + 1, "gemini")._tag).toBe("Open")

    // A LATER reading with room DOES lift the limit before resetAt
    const laterRoomy: AntigravityReport = {
      host: "mac",
      at: limitAt + 20 * MINUTE,
      readableSignIn: true,
      limits: [],
      reading: {
        at: limitAt + 20 * MINUTE,
        host: "mac",
        windows: [
          { group: "gemini", label: "Gemini", span: "5h", used: 0.1, resetAt: START + 5 * HOUR },
          { group: "gemini", label: "Gemini", span: "7d", used: 0.2, resetAt: START + 24 * HOUR },
        ],
      },
    }
    const withLater = mergeAll([fromReport(limitReport, limitAt), fromReport(laterRoomy, limitAt + 20 * MINUTE)])
    expect(mergedAnswerAt(withLater, limitAt + 25 * MINUTE, "gemini")).toEqual(Answer.cases.Open.make({}))

    // A LATER reading on ANOTHER group does NOT lift gemini's limit
    const laterOtherGroup: AntigravityReport = {
      host: "mac",
      at: limitAt + 20 * MINUTE,
      readableSignIn: true,
      limits: [],
      reading: {
        at: limitAt + 20 * MINUTE,
        host: "mac",
        windows: [
          { group: "claude-gpt", label: "Claude & GPT (shared)", span: "5h", used: 0.1, resetAt: START + 5 * HOUR },
          { group: "claude-gpt", label: "Claude & GPT (shared)", span: "7d", used: 0.2, resetAt: START + 24 * HOUR },
        ],
      },
    }
    const withOther = mergeAll([fromReport(limitReport, limitAt), fromReport(laterOtherGroup, limitAt + 20 * MINUTE)])
    expect(mergedAnswerAt(withOther, limitAt + 25 * MINUTE, "gemini")).toEqual(Answer.cases.Limited.make({ until: resetAt, by: "limit" }))

    // Merging a second limit with an EARLIER reset never moves the reset earlier
    const earlierResetLimit: AntigravityReport = {
      host: "mac",
      at: limitAt + 5 * MINUTE,
      readableSignIn: true,
      limits: [{ group: "gemini", seenAt: limitAt + 5 * MINUTE, resetAt: START + HOUR, host: "mac", key: "id:err-2" }],
    }
    const bothLimits = mergeAll([fromReport(limitReport, limitAt), fromReport(earlierResetLimit, limitAt + 5 * MINUTE)])
    expect(mergedAnswerAt(bothLimits, limitAt + 10 * MINUTE, "gemini")).toEqual(Answer.cases.Limited.make({ until: resetAt, by: "limit" }))
  })

  test("an unreadable peer is shown stale with its age and never as open; nothing is ever unlimited because it is unknown", () => {
    const now = START + HOUR
    const freshOwn: AntigravityReport = {
      host: "mac",
      at: now - MINUTE,
      readableSignIn: true,
      limits: [],
      reading: {
        at: now - MINUTE,
        host: "mac",
        windows: [
          { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: now + 3 * HOUR },
          { group: "gemini", label: "Gemini", span: "7d", used: 0.3, resetAt: now + 48 * HOUR },
        ],
      },
    }
    const stalePeer = fromStalePeer({ host: "workbox", since: now - 12 * MINUTE, seenAt: now - 15 * MINUTE, message: "ssh timed out" })
    const merged = mergeRecords(fromReport(freshOwn, now), stalePeer)
    const answer = mergedAnswerAt(merged, now, "gemini")
    expect(answer._tag).not.toBe("Open")
    expect(answer._tag).toBe("Unknown")
    if (answer._tag === "Unknown") expect(answer.why._tag).toBe("PeerStale")
    const lines = mergedStatusLines(merged, now).join("\n")
    expect(lines).toContain("workbox")
    expect(lines).toContain("stale")
    expect(lines).toMatch(/12 min|15 min/)
    expect(lines).not.toMatch(/unlimited|100% left|no limit(?! seen)/i)
  })

  test("fleet Report schema carries AntigravityReport and decodes older reports without it", () => {
    const codec = Schema.fromJsonString(Report)
    const modern: Report = {
      host: "mac",
      at: START,
      starts: [],
      readings: [],
      antigravity: {
        host: "mac",
        at: START,
        readableSignIn: true,
        limits: [{ group: "gemini", seenAt: START, resetAt: START + HOUR, host: "mac", key: "id:abc" }],
        reading: {
          at: START,
          host: "mac",
          windows: [{ group: "gemini", label: "Gemini", span: "5h", used: 0.4, resetAt: START + 4 * HOUR }],
        },
        attempt: { id: "a1", at: START, nextReadAt: START + 5 * MINUTE, host: "mac" },
      },
    }
    const roundtripped = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(modern))
    expect(roundtripped).toEqual(modern)
    // Older host without antigravity field still decodes cleanly
    const older = Schema.decodeUnknownSync(codec)(`{"host":"old","at":${START},"starts":[],"readings":[]}`)
    expect(older.antigravity).toBeUndefined()
  })

  test("readingHost picks the lowest host id among fresh hosts with a readable sign-in", () => {
    const now = START + HOUR
    const mk = (host: string, readableSignIn: boolean) => fromReport({ host, at: now, readableSignIn, limits: [] }, now)
    expect(readingHost(mergeAll([mk("mac", true), mk("bite-cristian", true)]))).toEqual(Option.some("bite-cristian"))
    expect(readingHost(mergeAll([mk("mac", true), mk("bite-cristian", false)]))).toEqual(Option.some("mac"))
    expect(readingHost(mergeAll([mk("mac", false), mk("bite-cristian", false)]))).toEqual(Option.none())
    // A stale peer with lower id does not block a fresh peer with a readable sign-in
    const withStale = mergeAll([mk("mac", true), fromStalePeer({ host: "bite-cristian", since: now - 5 * MINUTE, message: "down" })])
    expect(readingHost(withStale)).toEqual(Option.some("mac"))
  })

  test("resolveGroup maps model ids and group labels to canonical quota groups", () => {
    expect(resolveGroup("gemini-3-pro")).toEqual(Option.some("gemini"))
    expect(resolveGroup("google/gemini-2.5-pro#high")).toEqual(Option.some("gemini"))
    expect(resolveGroup("Gemini")).toEqual(Option.some("gemini"))
    expect(resolveGroup("claude-opus-4-6")).toEqual(Option.some("claude-gpt"))
    expect(resolveGroup("anthropic/claude-opus-4-6#max")).toEqual(Option.some("claude-gpt"))
    expect(resolveGroup("openai/gpt-5.3-codex")).toEqual(Option.some("claude-gpt"))
    expect(resolveGroup("Claude & GPT (shared)")).toEqual(Option.some("claude-gpt"))
    expect(resolveGroup("third-party")).toEqual(Option.some("claude-gpt"))
    expect(resolveGroup("unknown-model-xyz")).toEqual(Option.none())
  })

  test("openDecisionAt answers from the merged record with a finite time whenever not open now, and never blocks on unknown windows", () => {
    const now = START + HOUR
    // Measured open -> Now(measured: true)
    const roomy = fromReport(
      {
        host: "mac",
        at: now - MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: now - MINUTE,
          host: "mac",
          windows: [
            { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: now + 3 * HOUR },
            { group: "gemini", label: "Gemini", span: "7d", used: 0.3, resetAt: now + 48 * HOUR },
          ],
        },
      },
      now,
    )
    const open = openDecisionAt(roomy, now, "gemini")
    expect(open._tag).toBe("Now")
    if (open._tag === "Now") expect(open.measured).toBe(true)

    // Missing/absent 7d window -> Now(measured: false), never blocks by itself, answer is Unknown (not Open)
    const partial = fromReport(
      {
        host: "mac",
        at: now - MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: now - MINUTE,
          host: "mac",
          windows: [{ group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: now + 3 * HOUR }],
        },
      },
      now,
    )
    const nullable = openDecisionAt(partial, now, "gemini")
    expect(nullable._tag).toBe("Now")
    if (nullable._tag === "Now") {
      expect(nullable.measured).toBe(false)
      expect(nullable.answer._tag).toBe("Unknown")
    }

    // Peer limit with reset -> NotNow with finite until > now
    const peerLimit = fromReport(
      {
        host: "workbox",
        at: now,
        readableSignIn: false,
        limits: [{ group: "claude-gpt", seenAt: now, resetAt: now + 65 * MINUTE, host: "workbox" }],
      },
      now,
    )
    const limited = openDecisionAt(mergeRecords(roomy, peerLimit), now, "claude-gpt")
    expect(limited._tag).toBe("NotNow")
    if (limited._tag === "NotNow") {
      expect(Number.isFinite(limited.until)).toBe(true)
      expect(limited.until).toBe(now + 65 * MINUTE)
    }

    // Peer limit WITHOUT reset -> STILL NotNow with a finite recheck time > now!
    const noResetLimit = fromReport(
      {
        host: "workbox",
        at: now,
        readableSignIn: false,
        limits: [{ group: "gemini", seenAt: now, host: "workbox" }],
      },
      now,
    )
    const finite = openDecisionAt(mergeRecords(roomy, noResetLimit), now, "gemini")
    expect(finite._tag).toBe("NotNow")
    if (finite._tag === "NotNow") {
      expect(Number.isFinite(finite.until)).toBe(true)
      expect(finite.until).toBeGreaterThan(now)
    }
    expect(OpenStatus.cases.NotNow).toBeDefined()
  })
})

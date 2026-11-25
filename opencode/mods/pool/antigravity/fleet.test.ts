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
  CLOCK_SKEW_BOUND_MS,
  EMPTY_MERGED,
  fromLocalState,
  fromReport,
  fromStalePeer,
  type HostFacts,
  type HostFailure,
  type LimitEvent,
  MAX_RESET_HORIZON_MS,
  mergeAll,
  mergeFleet,
  mergedAnswerAt,
  mergedNextReadAt,
  mergedWindowAt,
  mergeRecords,
  type MergedRecord,
  openDecisionAt,
  OpenStatus,
  readingHost,
  resolveGroup,
  WireWhy,
} from "./fleet.ts"
import type { Span, Window } from "./quota.ts"
import { Answer, EMPTY, Event, evolve, READ_EVERY_MS, Shown, Why } from "./state.ts"
import { mergedStatusLines, statusLines } from "./text.ts"

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

const genWireWhy = (random: Random): WireWhy => {
  const roll = Math.floor(random() * 6)
  if (roll === 0) return WireWhy.cases.RequestFailed.make({ why: "refused", status: 401 })
  if (roll === 1) return WireWhy.cases.RequestFailed.make({ why: "rate-limited", status: 429 })
  if (roll === 2) return WireWhy.cases.RequestFailed.make({ why: "timed-out" })
  if (roll === 3) return WireWhy.cases.NotSignedIn.make({})
  if (roll === 4) return WireWhy.cases.KeychainRefused.make({ outcome: pick(random, ["denied", "failed", "timed-out"]) })
  return WireWhy.cases.FromNewerHost.make({})
}

const genHostFacts = (random: Random, host: string, now: number): HostFacts => {
  // Intentionally generate arbitrary combinations: fresh-only, missed-only, both,
  // same-timestamp ties, and seenAt >= since (the reviewer's counterexample).
  const tPool = [now - 20 * MINUTE, now - 15 * MINUTE, now - 10 * MINUTE, now - 5 * MINUTE, now] as const
  const base: HostFacts = { host }
  const withFresh = Match.value(random() < 0.6).pipe(
    Match.when(true, () => ({ ...base, fresh: { at: pick(random, tPool), readableSignIn: random() < 0.5 } })),
    Match.orElse(() => base),
  )
  const withMissed = Match.value(random() < 0.6).pipe(
    Match.when(true, () => ({ ...withFresh, missed: { since: pick(random, tPool), message: pick(random, ["ssh timed out", "eof", "refused"]) } })),
    Match.orElse(() => withFresh),
  )
  const withSeen = Match.value(random() < 0.7).pipe(
    Match.when(true, () => ({ ...withMissed, lastSeenAt: pick(random, tPool) })),
    Match.orElse(() => withMissed),
  )
  return Match.value(random() < 0.25).pipe(
    Match.when(true, () => ({ ...withSeen, fromNewerHost: true })),
    Match.orElse(() => withSeen),
  )
}

/** Generate an arbitrary MergedRecord (not just fleet-shaped), with ties in timestamps, keys, and failures. */
const genArbitraryRecord = (random: Random, now: number): MergedRecord => {
  const hostCount = 1 + Math.floor(random() * HOSTS.length)
  const chosen = HOSTS.slice(0, hostCount)
  const hosts = chosen.map((host) => genHostFacts(random, host, now))
  const sharedKeys = ["id:shared-1", "text:shared-2", "id:unique-a"] as const
  const limits: Array<LimitEvent> = chosen.flatMap((host) => {
    const count = Math.floor(random() * 3)
    return Array.from({ length: count }, () => {
      const seenAt = now - pick(random, [0, 5 * MINUTE, 10 * MINUTE, 20 * MINUTE])
      const base: LimitEvent = { group: pick(random, GROUPS), seenAt, host }
      const withReset = Match.value(random() < 0.8).pipe(
        Match.when(true, () => ({ ...base, resetAt: seenAt + pick(random, [30 * MINUTE, 60 * MINUTE]) })),
        Match.orElse(() => base),
      )
      return Match.value(random() < 0.7).pipe(
        Match.when(true, () => ({ ...withReset, key: pick(random, sharedKeys) })),
        Match.orElse(() => withReset),
      )
    })
  })
  const failures: Array<HostFailure> = chosen.flatMap((host) =>
    Match.value(random() < 0.6).pipe(
      Match.when(true, () => [{ host, at: now - pick(random, [0, 5 * MINUTE]), why: genWireWhy(random) }]),
      Match.orElse(() => []),
    ),
  )
  // Normalize through mergeRecords(EMPTY_MERGED, raw) so inputs are valid canonical semilattice elements
  return mergeRecords(EMPTY_MERGED, {
    hosts,
    limits,
    seenLimitKeys: limits.flatMap((l) => Option.toArray(Option.fromUndefinedOr(l.key))),
    readings: chosen.flatMap((host) =>
      Match.value(random() < 0.5).pipe(
        Match.when(true, () => [{ at: now - pick(random, [0, 5 * MINUTE]), host, windows: genWindows(random, now) }]),
        Match.orElse(() => []),
      ),
    ),
    attempts: [],
    failures,
  })
}

describe("Antigravity fleet merge laws (property-tested)", () => {
  test("mergeRecords is commutative, associative, and idempotent across N hosts, permutations, duplicates, delays and stale peers", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = generator(seed)
      const now = START + Math.floor(random() * 10 * HOUR)
      const a = genArbitraryRecord(random, now)
      const b = genArbitraryRecord(random, now)
      const c = genArbitraryRecord(random, now)
      // Commutative
      expect(mergeRecords(a, b)).toEqual(mergeRecords(b, a))
      // Associative (arbitrary triples, including seenAt >= since and failure ties)
      expect(mergeRecords(mergeRecords(a, b), c)).toEqual(mergeRecords(a, mergeRecords(b, c)))
      // Idempotent
      expect(mergeRecords(a, a)).toEqual(a)
      // Identity
      expect(mergeRecords(a, EMPTY_MERGED)).toEqual(a)
      expect(mergeRecords(EMPTY_MERGED, a)).toEqual(a)
      // Permutation & duplication invariance over fleet-shaped pieces too
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

  test("B1 cross-host merge: same key seen later on a peer keeps earliest sighting and never moves reset later", () => {
    const first = fromReport(
      {
        host: "workbox",
        at: START,
        readableSignIn: false,
        limits: [{ group: "gemini", seenAt: START, resetAt: START + 60 * MINUTE, host: "workbox", key: "text:sameframe" }],
      },
      START,
    )
    const replayOnPeer = fromReport(
      {
        host: "mac",
        at: START + 10 * MINUTE,
        readableSignIn: true,
        limits: [{ group: "gemini", seenAt: START + 10 * MINUTE, resetAt: START + 70 * MINUTE, host: "mac", key: "text:sameframe" }],
      },
      START + 10 * MINUTE,
    )
    const merged = mergeRecords(first, replayOnPeer)
    expect(mergedAnswerAt(merged, START + 20 * MINUTE, "gemini")).toEqual(Answer.cases.Limited.make({ until: START + 60 * MINUTE, by: "limit" }))
    expect(mergeRecords(first, replayOnPeer)).toEqual(mergeRecords(replayOnPeer, first))
  })

  test("B2 clock skew: within 5-min skew bound a cross-host reading never lifts a live limit early; beyond it errs toward limited and clamps extreme resets", () => {
    expect(CLOCK_SKEW_BOUND_MS).toBe(READ_EVERY_MS)
    expect(MAX_RESET_HORIZON_MS).toBe(7 * 24 * HOUR + CLOCK_SKEW_BOUND_MS)
    const SKEW_BOUND = CLOCK_SKEW_BOUND_MS
    const MAX_HORIZON = MAX_RESET_HORIZON_MS
    // Direct reproduction of Probe 3: reader clock 5m ahead stamps a reading taken 3m before the limit as T+2m
    const limitT = START + HOUR
    const limitRec = fromReport(
      {
        host: "workbox",
        at: limitT,
        readableSignIn: false,
        limits: [{ group: "gemini", seenAt: limitT, resetAt: limitT + HOUR, host: "workbox", key: "id:skew-1" }],
      },
      limitT,
    )
    const skewedReading = fromReport(
      {
        host: "mac",
        at: limitT + 2 * MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: limitT + 2 * MINUTE,
          host: "mac",
          windows: [
            { group: "gemini", label: "Gemini", span: "5h", used: 0.1, resetAt: limitT + 4 * HOUR },
            { group: "gemini", label: "Gemini", span: "7d", used: 0.1, resetAt: limitT + 48 * HOUR },
          ],
        },
      },
      limitT + 2 * MINUTE,
    )
    const merged = mergeRecords(limitRec, skewedReading)
    // Must stay Limited, NOT Open!
    expect(openDecisionAt(merged, limitT + MINUTE, "gemini")._tag).toBe("NotNow")

    // Contrast: a reading from the SAME host ("workbox") 1 minute later on its own clock DOES lift the limit!
    const sameHostLater = fromReport(
      {
        host: "workbox",
        at: limitT + MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: limitT + MINUTE,
          host: "workbox",
          windows: [
            { group: "gemini", label: "Gemini", span: "5h", used: 0.1, resetAt: limitT + 4 * HOUR },
            { group: "gemini", label: "Gemini", span: "7d", used: 0.1, resetAt: limitT + 48 * HOUR },
          ],
        },
      },
      limitT + MINUTE,
    )
    expect(openDecisionAt(mergeRecords(limitRec, sameHostLater), limitT + 2 * MINUTE, "gemini")._tag).toBe("Now")

    // Property over generated per-host clock offsets up to the bound and beyond:
    for (let seed = 400; seed <= 520; seed++) {
      const random = generator(seed)
      const trueNow = START + 2 * HOUR
      const trueLimitAt = trueNow - Math.floor(random() * 5 * MINUTE)
      const trueReadBeforeLimit = trueLimitAt - Math.floor(random() * 3 * MINUTE)
      // Within bound: |offsetReader - offsetPane| <= SKEW_BOUND
      const paneOffset = Math.floor((random() * 2 - 1) * (SKEW_BOUND / 2))
      const readerOffset = Math.floor((random() * 2 - 1) * (SKEW_BOUND / 2))
      const seenAt = trueLimitAt + paneOffset
      const resetAt = seenAt + HOUR
      const readAt = trueReadBeforeLimit + readerOffset
      const rec = mergeRecords(
        fromReport({ host: "pane-host", at: seenAt, readableSignIn: false, limits: [{ group: "gemini", seenAt, resetAt, host: "pane-host", key: `id:s-${seed}` }] }, trueNow),
        fromReport(
          {
            host: "reader-host",
            at: readAt,
            readableSignIn: true,
            limits: [],
            reading: {
              at: readAt,
              host: "reader-host",
              windows: [
                { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: trueNow + 4 * HOUR },
                { group: "gemini", label: "Gemini", span: "7d", used: 0.2, resetAt: trueNow + 48 * HOUR },
              ],
            },
          },
          trueNow,
        ),
      )
      const decision = openDecisionAt(rec, trueNow, "gemini")
      expect(decision._tag).toBe("NotNow")
      if (decision._tag === "NotNow") {
        expect(Number.isFinite(decision.until)).toBe(true)
        expect(decision.until).toBeLessThanOrEqual(trueNow + MAX_HORIZON)
      }
    }

    // Beyond the bound: extreme future reset (30 days ahead from a broken clock) is clamped to 7d + 5m, finite
    const absurdReset = fromReport(
      {
        host: "broken-clock",
        at: limitT,
        readableSignIn: false,
        limits: [{ group: "gemini", seenAt: limitT, resetAt: limitT + 30 * 24 * HOUR, host: "broken-clock", key: "id:absurd" }],
      },
      limitT,
    )
    const clamped = openDecisionAt(absurdReset, limitT, "gemini")
    expect(clamped._tag).toBe("NotNow")
    if (clamped._tag === "NotNow") {
      expect(clamped.until).toBe(limitT + MAX_HORIZON)
    }

    // Beyond the bound: reader clock +10m ahead of `now` stamps reading in the future (> now + 5m) -> errs toward Limited!
    const futureReader = fromReport(
      {
        host: "fast-reader",
        at: limitT + 10 * MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: limitT + 10 * MINUTE,
          host: "fast-reader",
          windows: [
            { group: "gemini", label: "Gemini", span: "5h", used: 0.1, resetAt: limitT + 4 * HOUR },
            { group: "gemini", label: "Gemini", span: "7d", used: 0.1, resetAt: limitT + 48 * HOUR },
          ],
        },
      },
      limitT,
    )
    const beyondDecision = openDecisionAt(mergeRecords(limitRec, futureReader), limitT + MINUTE, "gemini")
    expect(beyondDecision._tag).toBe("NotNow")
    if (beyondDecision._tag === "NotNow") expect(Number.isFinite(beyondDecision.until)).toBe(true)
  })

  test("B3 associativity & commutativity: reviewer counterexample (stale seenAt > another stale since) and failure payload ties", () => {
    const F = fromReport({ host: "x", at: 15, readableSignIn: true, limits: [] }, 15)
    const S = fromStalePeer({ host: "x", since: 10, seenAt: 20, message: "err" })
    const X = fromStalePeer({ host: "x", since: 18, message: "err" })
    expect(mergeRecords(mergeRecords(F, S), X)).toEqual(mergeRecords(F, mergeRecords(S, X)))
    expect(mergeRecords(F, S)).toEqual(mergeRecords(S, F))

    // Failure payload ties at the same timestamp and same _tag must still be commutative and associative
    const f401 = fromReport(
      { host: "x", at: 100, readableSignIn: true, limits: [], failure: { at: 100, why: WireWhy.cases.RequestFailed.make({ why: "refused", status: 401 }) } },
      100,
    )
    const f429 = fromReport(
      { host: "x", at: 100, readableSignIn: true, limits: [], failure: { at: 100, why: WireWhy.cases.RequestFailed.make({ why: "rate-limited", status: 429 }) } },
      100,
    )
    const f500 = fromReport(
      { host: "x", at: 100, readableSignIn: true, limits: [], failure: { at: 100, why: WireWhy.cases.RequestFailed.make({ why: "failed", status: 500 }) } },
      100,
    )
    expect(mergeRecords(f401, f429)).toEqual(mergeRecords(f429, f401))
    expect(mergeRecords(mergeRecords(f401, f429), f500)).toEqual(mergeRecords(f401, mergeRecords(f429, f500)))
  })

  test("B4 wire privacy: encoded report from NotSignedIn state contains neither home directory nor profile path, while local text keeps it", () => {
    const profile = "/Users/cvr/.local/state/opencode-pool/antigravity/profiles/default"
    const localState = evolve(EMPTY, Event.cases.Unavailable.make({ at: START, why: Why.cases.NotSignedIn.make({ profile }) }))
    // Local text keeps the profile path
    expect(statusLines(localState, START).join("\n")).toContain(profile)
    // Wire report carries NO path, NO home dir, NO user name
    const wireReport = fromLocalState("mac", localState, START, false)
    const codec = Schema.fromJsonString(Report)
    const encoded = Schema.encodeSync(codec)({ host: "mac", at: START, starts: [], readings: [], antigravity: wireReport })
    expect(encoded).not.toContain("/Users/cvr")
    expect(encoded).not.toContain(profile)
    expect(encoded).not.toContain("profiles/default")
    expect(encoded).not.toContain("/")
  })

  test("B5 tolerant decoding: unknown reason, extra field, and garbage Antigravity part keep peer pool data identical", () => {
    const codec = Schema.fromJsonString(Report)
    const jsonUnknown = Schema.fromJsonString(Schema.Unknown)
    const basePool = {
      host: "workbox",
      at: START,
      starts: [{ providerID: "anthropic", at: START - MINUTE }],
      busy: ["anthropic", "openai"],
      readings: [],
    }
    const baseDecoded = Schema.decodeUnknownSync(codec)(Schema.encodeSync(jsonUnknown)(basePool))

    const futureReason = Object.fromEntries([
      ["_tag", "FutureReasonFromNewerHost"],
      ["code", 99],
    ])
    const cases = [
      {
        name: "unknown reason",
        antigravity: {
          host: "workbox",
          at: START,
          readableSignIn: false,
          limits: [],
          failure: { at: START, why: futureReason },
        },
        expectNewerHost: true,
      },
      {
        name: "extra field",
        antigravity: {
          host: "workbox",
          at: START,
          readableSignIn: true,
          limits: [],
          futureCapability: { version: 99 },
        },
        expectNewerHost: true,
      },
      {
        name: "unknown group and unknown window span",
        antigravity: {
          host: "workbox",
          at: START,
          readableSignIn: true,
          limits: [],
          reading: {
            at: START,
            host: "workbox",
            windows: [
              { group: "future-family", label: "Future", span: "5h", used: 0.2, resetAt: START + 4 * HOUR },
              { group: "gemini", label: "Gemini", span: "30d", used: 0.1, resetAt: START + 24 * HOUR },
            ],
          },
        },
        expectNewerHost: true,
      },
      {
        name: "garbage antigravity",
        antigravity: "not-a-valid-antigravity-report",
        expectNewerHost: false,
      },
    ]

    for (const item of cases) {
      const json = Schema.encodeSync(jsonUnknown)({ ...basePool, antigravity: item.antigravity })
      const decoded = Schema.decodeUnknownOption(codec)(json)
      expect(Option.isSome(decoded)).toBe(true)
      const rep = Option.getOrThrow(decoded)
      expect(rep.host).toBe(baseDecoded.host)
      expect(rep.at).toBe(baseDecoded.at)
      expect(rep.starts).toEqual(baseDecoded.starts)
      expect(rep.busy).toEqual(baseDecoded.busy)
      expect(rep.readings).toEqual(baseDecoded.readings)

      const own: AntigravityReport = { host: "mac", at: START, readableSignIn: true, limits: [] }
      const merged = mergeFleet(own, { workbox: { report: rep, seenAt: START } }, ["workbox"], START)
      const lines = mergedStatusLines(merged, START).join("\n")
      if (item.expectNewerHost) {
        expect(lines).toContain("unknown, from a newer host")
      } else {
        expect(lines).not.toContain("unknown, from a newer host")
      }
    }
  })
})

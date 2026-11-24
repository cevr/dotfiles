// The ChatGPT quota source: the usage endpoint's answer, a response's headers
// and a websocket frame each read as the same windows; a failure is no reading;
// the quota RPC it serves answers a fresh held reading without asking again.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Fiber, Match, Option, Schema, Stream } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { AccountPool, HoldCleared, ReadingTaken, TakeReading } from "../account-pool.ts"
import { DEFAULT_RULES } from "../accounts.ts"
import { dispatchPace } from "../pace.ts"
import { carryOver, type QuotaReading, windowReading } from "../quota.ts"
import { fromFrame, fromHeaders, fromUsage, make, usageKeys, withCredits } from "./usage.ts"

const now = Date.parse("2026-11-05T14:21:00Z")
/** The JSON `null` a slot holds for a window the account does not have. */
const NONE = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")
const weekReset = Date.parse("2026-11-11T07:36:00Z") / 1000

/** The usage endpoint's answer as measured on both hosts at 14:21Z: 16% of the week, no 5-hour window. */
const observedUsage = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 16, limit_window_seconds: 604_800, reset_after_seconds: 500_000, reset_at: weekReset },
    secondary_window: null,
  },
}

describe("ChatGPT usage readings", () => {
  test("the usage endpoint's windows read as the pool's 5h and 7d windows", () => {
    // A weekly-only plan: its 5-hour window is ABSENT (the answer's other slot is null), not unread.
    expect(fromUsage(observedUsage, now)).toEqual({
      at: now, status: "allowed", windows: [{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 + 1001 }],
      usage: { at: now, samples: 1 }, unrecognised: [], absent: [{ name: "5h", at: now }],
    })
    const both = {
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_800_100_000 },
      },
    }
    expect(fromUsage(both, now)).toEqual({
      at: now,
      status: "rejected",
      windows: [
        { name: "5h", utilization: 1, resetAt: 1_800_000_001_001 },
        { name: "7d", utilization: 0.4, resetAt: 1_800_100_001_001 },
      ],
      refusal: { kind: "usage-limit", until: 1_800_000_001_001 },
      usage: { at: now, samples: 1 },
      unrecognised: [],
    })
    expect(fromUsage({ detail: "Unauthorized" }, now)).toBeUndefined()
    // A slot missing: the windows it may hold are UNKNOWN, and with none read the answer is a failed read.
    expect(fromUsage({ rate_limit: { primary_window: NONE } }, now)).toBeUndefined()
    // Both slots null: no window at all, both ABSENT.
    expect(fromUsage({ rate_limit: { primary_window: NONE, secondary_window: NONE } }, now)).toMatchObject({
      windows: [], absent: [{ name: "5h", at: now }, { name: "7d", at: now }], unrecognised: [],
    })
    // A slot in a shape that does not read is named, and absences are not inferred around it.
    const changed = fromUsage({ rate_limit: { ...observedUsage.rate_limit, secondary_window: { used: "16%" } } }, now)
    expect(changed).toMatchObject({ unrecognised: ["rate_limit.secondary_window"] })
    expect(changed).not.toHaveProperty("absent")
    // A zero or negative window length is malformed, never valid and never infers absence.
    const zeroSpan = fromUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 0 }, secondary_window: NONE } }, now)
    expect(zeroSpan).toBeUndefined()
    // Missing secondary slot leaves 5h UNKNOWN without naming an unrecognised field.
    const omitted = fromUsage({ rate_limit: { primary_window: observedUsage.rate_limit.primary_window } }, now)
    expect(omitted).toMatchObject({ unrecognised: [] })
    expect(omitted).not.toHaveProperty("absent")
    // A slot with an unknown duration alongside an unreadable slot reads no tracked window: failed read.
    expect(fromUsage({ rate_limit: { primary_window: { used_percent: 16, limit_window_seconds: 3_600 }, secondary_window: { used: "bad" } } }, now)).toBeUndefined()
    // Key names for failed reads carry no values and no tokens.
    expect(usageKeys(Option.some({ rate_limit: { primary_window: "secret-val" }, extra: "tok" }))).toBe("keys extra, rate_limit; rate_limit keys primary_window")
  })

  effectTest("ChatGPT usage readings carry usage evidence: lifting sign-in, repairing unreadable holds, and tracking model-unreported samples", Effect.gen(function* () {
    const decider = AccountPool(DEFAULT_RULES)
    const first = Option.getOrThrow(Option.fromUndefinedOr(fromUsage(observedUsage, now + 60_000)))
    const signInHeld = { ...decider.initial, credentials: ["codex"], holds: { codex: { kind: "signin" as const, at: now, until: now + 60_000 } } }
    const lifted = yield* decider.decide(signInHeld, TakeReading.make({ credentialID: "codex", reading: first }), now + 60_000)
    expect(lifted).toEqual([ReadingTaken.make({ credentialID: "codex", reading: first }), HoldCleared.make({ credentialID: "codex" })])
    const damaged = { ...decider.initial, credentials: ["codex"], holds: { codex: { kind: "record-unreadable" as const, at: now, until: now + 60_000 } } }
    const repaired = yield* decider.decide(damaged, TakeReading.make({ credentialID: "codex", reading: first, freshUsage: true }), now + 60_000)
    expect(repaired).toEqual([ReadingTaken.make({ credentialID: "codex", reading: first }), HoldCleared.make({ credentialID: "codex" })])
    const second = Option.getOrThrow(Option.fromUndefinedOr(fromUsage(observedUsage, now + 120_000)))
    const combined = carryOver(first, second)
    expect(combined.usage).toEqual({ at: now + 120_000, samples: 2 })
    const pace = dispatchPace([{ credentialID: "codex", live: 0, load: 0, noRoom: false, reading: combined }], now + 120_000, {}, 0.04, "claude-fable-5-2")
    expect(pace).toMatchObject({ ok: false, reasonCode: "model-unreported" })
  }), hangGuard("unit-law"))

  test("every combination of the two slots maps each tracked window to its three states", () => {
    const layouts = [
      { holds: Option.some("5h"), slot: Option.some<unknown>({ used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }) },
      { holds: Option.some("7d"), slot: Option.some<unknown>({ used_percent: 30, limit_window_seconds: 604_800, reset_at: 1_800_100_000 }) },
      { holds: Option.none<string>(), slot: Option.some<unknown>(NONE) },
      { holds: Option.none<string>(), slot: Option.none<unknown>() },
      { holds: Option.none<string>(), slot: Option.some<unknown>({ used: "30%" }) },
    ]
    for (const [primary, secondary] of Arr.cartesian(layouts, layouts)) {
      const rate_limit = {
        ...Option.match(primary.slot, { onNone: () => ({}), onSome: (primary_window) => ({ primary_window }) }),
        ...Option.match(secondary.slot, { onNone: () => ({}), onSome: (secondary_window) => ({ secondary_window }) }),
      }
      const reading = Option.fromUndefinedOr(fromUsage({ rate_limit }, now))
      // Both slots read (a window or null): a window neither holds is ABSENT. A slot missing or unreadable: UNKNOWN.
      const complete = [primary, secondary].every((layout) => Option.isSome(layout.holds) || Option.exists(layout.slot, (slot) => slot === NONE))
      const held = [primary.holds, secondary.holds].flatMap(Option.toArray)
      const expected = (name: string) => Match.value({ reported: held.includes(name), complete }).pipe(
        Match.when({ reported: true }, () => "Reported"),
        Match.when({ complete: true }, () => "Absent"),
        Match.orElse(() => "Unknown"),
      )
      const tags: Array<string> = ["5h", "7d"].map(expected)
      expect([rate_limit, Option.isSome(reading)]).toEqual([rate_limit, tags.some((tag) => tag !== "Unknown")])
      Option.map(reading, (reading) =>
        expect({ rate_limit, tags: [windowReading(reading, "5h")._tag, windowReading(reading, "7d")._tag].map(String) }).toEqual({ rate_limit, tags }))
    }
  })

  test("reset credits: the usage endpoint's count, and the credit list with what a claim needs", () => {
    // As measured on 2026-11-09: two credits, neither applicable while the account is not limited.
    const withCount = { ...observedUsage, rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } }
    const reading = fromUsage(withCount, now)
    expect(reading?.resets).toEqual({ available: 2, credits: [] })
    const listed = {
      credits: [
        { id: "credit-b", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-11-01T22:37:04Z", expires_at: "2026-12-01T22:37:04.252537Z" },
        { id: "credit-a", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-10-31T20:04:23Z", expires_at: "2026-11-30T20:04:23.734225Z" },
        { id: "credit-used", reset_type: "codex_rate_limits", status: "redeemed", granted_at: "2026-10-01T00:00:00Z", expires_at: null },
        { status: "available" },
      ],
      available_count: 2,
    }
    expect(withCredits(reading as QuotaReading, listed).resets).toEqual({
      available: 2,
      nextExpiresAt: Date.parse("2026-11-30T20:04:23.734225Z"),
      credits: [
        { id: "credit-b", count: 1, usable: true, status: "available", expiresAt: Date.parse("2026-12-01T22:37:04.252537Z") },
        { id: "credit-a", count: 1, usable: true, status: "available", expiresAt: Date.parse("2026-11-30T20:04:23.734225Z") },
        { id: "credit-used", count: 1, usable: false, status: "redeemed" },
      ],
    })
    // A malformed list leaves the count as the usage endpoint read it.
    expect(withCredits(reading as QuotaReading, { detail: "nope" })).toEqual(reading as QuotaReading)
    expect(fromUsage(observedUsage, now)?.resets).toBeUndefined()
  })

  test("a model's own rate limit reads as a window scoped to it, never as the account's", () => {
    const additional = {
      ...observedUsage,
      additional_rate_limits: [
        {
          limit_name: "GPT-6-Astra",
          metered_feature: "codex_other",
          normal_model_slug: "gpt-6-astra",
          rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: weekReset } },
        },
      ],
    }
    expect(fromUsage(additional, now)).toEqual({
      at: now,
      status: "allowed",
      windows: [
        { name: "7d", utilization: 0.16, resetAt: weekReset * 1000 + 1001 },
        { name: "7d:GPT-6-Astra", utilization: 1, resetAt: weekReset * 1000 + 1001 },
      ],
      usage: { at: now, samples: 1 },
      unrecognised: [],
      absent: [{ name: "5h", at: now }],
    })
  })

  test("a response's x-codex headers and a codex.rate_limits frame read the same", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "16",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(weekReset),
    })
    const expected: QuotaReading = { at: now, status: "allowed", windows: [{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 + 1001 }] }
    expect(fromHeaders((name) => headers.get(name), now)).toEqual(expected)
    expect(fromHeaders(() => null, now)).toBeUndefined()
    const frame = JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 16, window_minutes: 10_080, reset_at: weekReset } } })
    expect(fromFrame(frame, now)).toEqual(expected)
    expect(fromFrame('{"type":"response.output_text.delta","delta":"hi"}', now)).toBeUndefined()
    expect(fromFrame("codex.rate_limits {not json", now)).toBeUndefined()
  })
})

describe("the ChatGPT quota source", () => {
  test("reads the endpoint with the login's token and account, holds the reading a minute, and publishes it", async () => {
    const seen: Array<{ authorization: string | null; account: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push({ authorization: request.headers.get("authorization"), account: request.headers.get("chatgpt-account-id") })
        return request.headers.get("authorization") === "Bearer good" ? Response.json(observedUsage) : new Response("no", { status: 401 })
      },
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = yield* make({
              login: (credentialID) =>
                Effect.succeed(credentialID === "chatgpt" ? { access: "good", accountID: "acct-1" } : credentialID === "expired" ? { access: "old" } : undefined),
              url: `http://127.0.0.1:${server.port}/backend-api/wham/usage`,
            })
            const first = yield* source.rpc.published.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.yieldNow
            const answer = yield* source.rpc.reading({ credentialID: "chatgpt" })
            expect(answer.reading?.windows).toEqual([{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 + 1001 }])
            // A second ask within the minute answers the held reading: one read of the endpoint.
            yield* source.rpc.reading({ credentialID: "chatgpt" })
            expect(seen).toEqual([{ authorization: "Bearer good", account: "acct-1" }])
            expect([...(yield* Fiber.join(first))].map((published) => published.credentialID)).toEqual(["chatgpt"])
            // A refused token, or a login that is not ChatGPT's, is no reading: the pace fails open.
            expect(yield* source.rpc.usage({ credentialID: "expired" })).toEqual({})
            expect(yield* source.rpc.usage({ credentialID: "elsewhere" })).toEqual({})
            expect(seen.length).toBe(2)
          }),
        ),
      )
    } finally {
      server.stop(true)
    }
  })

  test("an account with reset credits has its credit list read beside its usage; one without is not asked", async () => {
    const paths: Array<string> = []
    let count = 1
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path.endsWith("/wham/usage")) return Response.json({ ...observedUsage, rate_limit_reset_credits: { available_count: count } })
        if (path.endsWith("/wham/rate-limit-reset-credits"))
          return Response.json({ available_count: 1, credits: [{ id: "credit-a", status: "available", expires_at: "2026-11-30T20:04:23Z" }] })
        return new Response("no", { status: 404 })
      },
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = yield* make({
              login: () => Effect.succeed({ access: "good" }),
              url: `http://127.0.0.1:${server.port}/backend-api/wham/usage`,
            })
            const answer = yield* source.rpc.usage({ credentialID: "chatgpt" })
            expect(answer.reading?.resets).toEqual({
              available: 1,
              nextExpiresAt: Date.parse("2026-11-30T20:04:23Z"),
              credits: [{ id: "credit-a", count: 1, usable: true, status: "available", expiresAt: Date.parse("2026-11-30T20:04:23Z") }],
            })
            count = 0
            expect((yield* source.rpc.usage({ credentialID: "chatgpt" })).reading?.resets).toEqual({ available: 0, credits: [] })
            expect(paths).toEqual(["/backend-api/wham/usage", "/backend-api/wham/rate-limit-reset-credits", "/backend-api/wham/usage"])
          }),
        ),
      )
    } finally {
      server.stop(true)
    }
  })

  test("a claim consumes the credit under the pool's request id on a stand-in backend (never the real one), each code in the pool's words", async () => {
    const posts: Array<{ readonly path: string; readonly body: unknown; readonly auth: string | null; readonly account: string | null }> = []
    let answer: () => Response = () => Response.json({ code: "reset", windows_reset: 2 })
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (request.method !== "POST") return new Response("no", { status: 405 })
        posts.push({ path, body: await request.json(), auth: request.headers.get("authorization"), account: request.headers.get("chatgpt-account-id") })
        return answer()
      },
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = yield* make({
              login: (credentialID) => Effect.succeed(credentialID === "chatgpt" ? { access: "good", accountID: "acct-1" } : undefined),
              url: `http://127.0.0.1:${server.port}/backend-api/wham/usage`,
            })
            const claim = (credentialID = "chatgpt") => source.rpc.claim({ credentialID, creditID: "credit-a", requestID: "pool-1" })
            expect(yield* claim()).toEqual({ outcome: "reset", message: "2 windows reset" })
            expect(posts).toEqual([
              { path: "/backend-api/wham/rate-limit-reset-credits/consume", body: { redeem_request_id: "pool-1", credit_id: "credit-a" }, auth: "Bearer good", account: "acct-1" },
            ])
            const cases: ReadonlyArray<readonly [Response, unknown]> = [
              [Response.json({ code: "nothing_to_reset" }), { outcome: "nothing-to-reset", message: "nothing_to_reset" }],
              [Response.json({ code: "no_credit" }), { outcome: "no-credit", message: "no_credit" }],
              [Response.json({ code: "already_redeemed" }), { outcome: "already-redeemed", message: "already_redeemed" }],
              [Response.json({ code: "later" }), { outcome: "failed", message: 'the claim\'s answer does not read: "later"' }],
              [new Response("slow", { status: 429 }), { outcome: "rate-limited", message: "ChatGPT is rate limiting resets" }],
              [new Response("no", { status: 401 }), { outcome: "signed-out", message: "the claim was refused: 401" }],
              [new Response("oops", { status: 500 }), { outcome: "failed", message: "the claim answered 500" }],
            ]
            for (const [response, expected] of cases) {
              answer = () => response.clone()
              expect<unknown>(yield* claim()).toEqual(expected)
            }
            expect(yield* claim("not-chatgpt")).toEqual({ outcome: "signed-out", message: "not a ChatGPT login" })
          }),
        ),
      )
    } finally {
      server.stop(true)
    }
  })

  test("a reading a response carried is held and published, unless it is older than the one held", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* make({ login: () => Effect.succeed(undefined), url: "http://127.0.0.1:9/never" })
          const reading = (at: number) => ({ at, windows: [{ name: "7d", utilization: 0.2 }] })
          const latest = reading(20_000)
          yield* source.observe("chatgpt", latest)
          yield* source.observe("chatgpt", reading(10_000))
          expect(yield* source.rpc.reading({ credentialID: "chatgpt" })).toMatchObject({ reading: latest })
        }),
      ),
    )
  })
})

// The ChatGPT quota source: the usage endpoint's answer, a response's headers
// and a websocket frame each read as the same windows; a failure is no reading;
// the quota RPC it serves answers a fresh held reading without asking again.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { QuotaReading } from "../quota.ts"
import { fromFrame, fromHeaders, fromUsage, make, withCredits } from "./usage.ts"

const now = Date.parse("2026-11-05T14:21:00Z")
const weekReset = Date.parse("2026-11-11T07:36:00Z") / 1000

/** The usage endpoint's answer as measured on both hosts at 14:21Z: 16% of the week, no 5-hour window. */
const measured = {
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
    expect(fromUsage(measured, now)).toEqual({ at: now, status: "allowed", windows: [{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 }] })
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
        { name: "5h", utilization: 1, resetAt: 1_800_000_000_000 },
        { name: "7d", utilization: 0.4, resetAt: 1_800_100_000_000 },
      ],
      refusal: { kind: "usage-limit", until: 1_800_000_000_000 },
    })
    expect(fromUsage({ detail: "Unauthorized" }, now)).toBeUndefined()
    expect(fromUsage({ rate_limit: { primary_window: null } }, now)).toBeUndefined()
  })

  test("reset credits: the usage endpoint's count, and the credit list with what a claim needs", () => {
    // As measured on 2026-11-09: two credits, neither applicable while the account is not limited.
    const withCount = { ...measured, rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } }
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
    expect(fromUsage(measured, now)?.resets).toBeUndefined()
  })

  test("a model's own rate limit reads as a window scoped to it, never as the account's", () => {
    const additional = {
      ...measured,
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
        { name: "7d", utilization: 0.16, resetAt: weekReset * 1000 },
        { name: "7d:GPT-6-Astra", utilization: 1, resetAt: weekReset * 1000 },
      ],
    })
  })

  test("a response's x-codex headers and a codex.rate_limits frame read the same", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "16",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(weekReset),
    })
    const expected: QuotaReading = { at: now, status: "allowed", windows: [{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 }] }
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
        return request.headers.get("authorization") === "Bearer good" ? Response.json(measured) : new Response("no", { status: 401 })
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
            expect(answer.reading?.windows).toEqual([{ name: "7d", utilization: 0.16, resetAt: weekReset * 1000 }])
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
        if (path.endsWith("/wham/usage")) return Response.json({ ...measured, rate_limit_reset_credits: { available_count: count } })
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
          yield* source.observe("chatgpt", reading(Date.now()))
          yield* source.observe("chatgpt", reading(Date.now() - 10_000))
          expect(yield* source.rpc.reading({ credentialID: "chatgpt" })).toMatchObject({ reading: { windows: [{ name: "7d", utilization: 0.2 }] } })
          expect(((yield* source.rpc.reading({ credentialID: "chatgpt" })) as { reading: { at: number } }).reading.at).toBeGreaterThan(Date.now() - 5000)
        }),
      ),
    )
  })
})

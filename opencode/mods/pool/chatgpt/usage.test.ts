// The ChatGPT quota source: the usage endpoint's answer, a response's headers
// and a websocket frame each read as the same windows; a failure is no reading;
// the quota RPC it serves answers a fresh held reading without asking again.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { QuotaReading } from "../quota.ts"
import { fromFrame, fromHeaders, fromUsage, make } from "./usage.ts"

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

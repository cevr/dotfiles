/**
 * A fake ChatGPT backend on a loopback port: the three endpoints the pool's
 * ChatGPT source reaches (`mods/pool/chatgpt/usage.ts`, after codex-rs
 * backend-client): `GET /backend-api/wham/usage`, the reset credits' list
 * `GET /backend-api/wham/rate-limit-reset-credits` and the claim
 * `POST /backend-api/wham/rate-limit-reset-credits/consume`. Each account is
 * named by its `chatgpt-account-id` and must send its access token. A
 * consume answers `reset` once per credit (a request id seen before
 * `already_redeemed`), and empties the account's windows and restarts its
 * week, as Codex's reset does. Every token is the test's fake; nothing here
 * reaches chatgpt.com.
 *
 * @module
 */

const DAY = 86_400_000
const HOUR = 3_600_000

export interface FakeChatGPTAccount {
  /** The access token its requests must carry. */
  readonly access: string
  /** Percent used of the 5-hour and the weekly windows. */
  fiveHour: number
  weekly: number
  /** When the 5-hour and weekly windows reset (epoch ms). */
  fiveHourResetAt: number
  weeklyResetAt: number
  /** Its reset credits: an id, whether it is still available, and when it expires (epoch ms). */
  credits: Array<{ readonly id: string; status: "available" | "redeemed"; readonly expiresAt: number }>
}

/** A consume the fake received: never a token. */
export interface FakeConsume {
  readonly account: string
  readonly creditID: unknown
  readonly requestID: unknown
  readonly code: string
}

export interface FakeChatGPT {
  readonly url: string
  /** The usage endpoint, as the pool's `usageURL` option takes it. */
  readonly usageURL: string
  readonly accounts: Map<string, FakeChatGPTAccount>
  readonly consumes: ReadonlyArray<FakeConsume>
  readonly stop: () => Promise<void>
}

/** An account whose 5-hour window is spent, its week `weekly` percent used, with one credit expiring in `creditIn`. */
export const spentAccount = (access: string, creditID: string, now = Date.now(), weekly = 40, creditIn = 20 * DAY): FakeChatGPTAccount => ({
  access,
  fiveHour: 100,
  weekly,
  fiveHourResetAt: now + 2 * HOUR,
  weeklyResetAt: now + 3 * DAY,
  credits: [{ id: creditID, status: "available", expiresAt: now + creditIn }],
})

const seconds = (at: number) => Math.round(at / 1000)

export const startFakeChatGPT = (options: { readonly beforeConsumeResponse?: () => Promise<void> } = {}): FakeChatGPT => {
  const accounts = new Map<string, FakeChatGPTAccount>()
  const consumes: Array<FakeConsume> = []
  const redeemed = new Set<string>()

  const accountOf = (request: Request) => {
    const id = request.headers.get("chatgpt-account-id") ?? ""
    const account = accounts.get(id)
    return account !== undefined && request.headers.get("authorization") === `Bearer ${account.access}` ? { id, account } : undefined
  }

  const usage = (account: FakeChatGPTAccount) => {
    const reached = account.fiveHour >= 100 || account.weekly >= 100
    return {
      plan_type: "pro",
      rate_limit: {
        allowed: !reached,
        limit_reached: reached,
        primary_window: { used_percent: account.fiveHour, limit_window_seconds: 18_000, reset_at: seconds(account.fiveHourResetAt) },
        secondary_window: { used_percent: account.weekly, limit_window_seconds: 604_800, reset_at: seconds(account.weeklyResetAt) },
      },
      rate_limit_reset_credits: { available_count: account.credits.filter((credit) => credit.status === "available").length },
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const found = accountOf(request)
      if (found === undefined) return new Response("unauthorized", { status: 401 })
      const { id, account } = found
      if (request.method === "GET" && path === "/backend-api/wham/usage") return Response.json(usage(account))
      if (request.method === "GET" && path === "/backend-api/wham/rate-limit-reset-credits")
        return Response.json({
          available_count: account.credits.filter((credit) => credit.status === "available").length,
          credits: account.credits.map((credit) => ({ id: credit.id, status: credit.status, expires_at: new Date(credit.expiresAt).toISOString() })),
        })
      if (request.method === "POST" && path === "/backend-api/wham/rate-limit-reset-credits/consume") {
        const body = (await request.json()) as { readonly redeem_request_id?: unknown; readonly credit_id?: unknown }
        const requestID = String(body.redeem_request_id)
        const credit = account.credits.find((item) => item.id === body.credit_id)
        const code = redeemed.has(requestID)
          ? "already_redeemed"
          : credit === undefined || credit.status !== "available"
            ? "no_credit"
            : account.fiveHour < 100 && account.weekly < 100
              ? "nothing_to_reset"
              : "reset"
        consumes.push({ account: id, creditID: body.credit_id, requestID: body.redeem_request_id, code })
        if (code === "reset" && credit !== undefined) {
          redeemed.add(requestID)
          credit.status = "redeemed"
          const now = Date.now()
          account.fiveHour = 0
          account.weekly = 0
          account.fiveHourResetAt = now + 5 * HOUR
          account.weeklyResetAt = now + 7 * DAY
        }
        // Let a test hold the reply after consumption, before the pool can settle its claim.
        if (options.beforeConsumeResponse !== undefined) await options.beforeConsumeResponse()
        return Response.json({ code, ...(code === "reset" ? { windows_reset: 2 } : {}) })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const url = server.url.origin
  return {
    url,
    usageURL: `${url}/backend-api/wham/usage`,
    accounts,
    consumes,
    stop: () => server.stop(true),
  }
}

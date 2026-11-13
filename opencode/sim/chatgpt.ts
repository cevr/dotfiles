// The ChatGPT backend as part of the world: the three endpoints the pool's
// ChatGPT source reaches (mods/pool/chatgpt/usage.ts) — the usage reading, the
// reset credits' list and the claim — answered as tests/fake-chatgpt.ts
// answers the real tier, in the same shapes, from the same accounts
// (`FakeChatGPTAccount`), on the world's clock. The pool reaches it through its
// `usageURL` option and the fetch its store host gives it (`sim/plugins.ts`);
// the world's provider routes a request to `ORIGIN` here
// (`Provider.Options.chatgpt`). sim/provider-laws.ts runs one set of exchanges
// on this and on the fake.
import { Clock, DateTime, Effect, Option, Schema } from "effect"
import type { FakeChatGPTAccount, FakeConsume } from "../tests/fake-chatgpt.ts"

export type { FakeChatGPTAccount as Account, FakeConsume as Consume }

/** Where the world's ChatGPT backend answers: a loopback origin nothing outside the world listens on. */
export const ORIGIN = "http://127.0.0.1:10"

/** The usage endpoint, as the pool's `usageURL` option takes it. */
export const USAGE_URL = `${ORIGIN}/backend-api/wham/usage`

const HOUR = 3_600_000
const DAY = 24 * HOUR

const ConsumeBody = Schema.Struct({ redeem_request_id: Schema.optional(Schema.Json), credit_id: Schema.optional(Schema.Json) })
const decodeConsume = Schema.decodeUnknownOption(Schema.fromJsonString(ConsumeBody))

const seconds = (at: number) => Math.round(at / 1000)

const json = (body: Schema.Json) => Response.json(body)
const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain;charset=utf-8" } })

/** The code a consume of `credit` answers, as the fake decides it. */
const codeOf = (seen: boolean, account: FakeChatGPTAccount, credit: Option.Option<FakeChatGPTAccount["credits"][number]>) => {
  if (seen) return "already_redeemed"
  if (Option.isNone(credit) || credit.value.status !== "available") return "no_credit"
  if (account.fiveHour < 100 && account.weekly < 100) return "nothing_to_reset"
  return "reset"
}

/** The usage reading of `account`, as the fake answers it. */
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

/** A world's ChatGPT backend: its accounts by `chatgpt-account-id`, which the test scripts, and the consumes it received. */
export const make = () => {
  const accounts = new Map<string, FakeChatGPTAccount>()
  const consumes: Array<FakeConsume> = []
  const redeemed = new Set<string>()

  /** The account a request names, when it carries that account's access token. */
  const accountOf = (request: Request) => {
    const id = request.headers.get("chatgpt-account-id") ?? ""
    return Option.filter(Option.fromNullishOr(accounts.get(id)), (account) => request.headers.get("authorization") === `Bearer ${account.access}`).pipe(
      Option.map((account) => ({ id, account })),
    )
  }

  const consume = (id: string, account: FakeChatGPTAccount, body: string) =>
    Effect.gen(function* () {
      const decoded = Option.getOrElse(decodeConsume(body), () => ConsumeBody.make({}))
      const requestID = String(decoded.redeem_request_id)
      const credit = Option.fromNullishOr(account.credits.find((item) => item.id === decoded.credit_id))
      const code = codeOf(redeemed.has(requestID), account, credit)
      consumes.push({ account: id, creditID: decoded.credit_id, requestID: decoded.redeem_request_id, code })
      if (code !== "reset") return json({ code })
      const now = yield* Clock.currentTimeMillis
      redeemed.add(requestID)
      for (const spent of Option.toArray(credit)) spent.status = "redeemed"
      account.fiveHour = 0
      account.weekly = 0
      account.fiveHourResetAt = now + 5 * HOUR
      account.weeklyResetAt = now + 7 * DAY
      return json({ code, windows_reset: 2 })
    })

  /** One HTTP exchange at `ORIGIN`. */
  const handle = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname
      const found = accountOf(request)
      if (Option.isNone(found)) return text("unauthorized", 401)
      const { id, account } = found.value
      if (request.method === "GET" && path === "/backend-api/wham/usage") return json(usage(account))
      if (request.method === "GET" && path === "/backend-api/wham/rate-limit-reset-credits")
        return json({
          available_count: account.credits.filter((credit) => credit.status === "available").length,
          credits: account.credits.map((credit) => ({
            id: credit.id,
            status: credit.status,
            expires_at: DateTime.formatIso(DateTime.makeUnsafe(credit.expiresAt)),
          })),
        })
      if (request.method === "POST" && path === "/backend-api/wham/rate-limit-reset-credits/consume")
        return yield* consume(id, account, yield* Effect.promise(() => request.text()))
      return text("not found", 404)
    })

  return {
    origin: ORIGIN,
    handle,
    accounts,
    /** Every consume, in order: never a token. */
    consumes: (): ReadonlyArray<FakeConsume> => consumes,
  }
}

export type Backend = ReturnType<typeof make>

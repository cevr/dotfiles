// The ChatGPT account's Codex quota, as the provider itself measures it: the
// same windows Codex CLI's /status shows, counting every place the account is
// used (this host, the workbox, Codex CLI, the ChatGPT apps). Three ways in,
// all from openai/codex (codex-rs):
// - GET https://chatgpt.com/backend-api/wham/usage with the login's bearer
//   token and `chatgpt-account-id` (backend-client/src/client/rate_limit_resets.rs:128-131,
//   headers in client.rs:367-385): `rate_limit.primary_window` and
//   `secondary_window`, each `used_percent`, `limit_window_seconds` and
//   `reset_at` in Unix seconds (codex-backend-openapi-models rate_limit_window_snapshot.rs).
// - The `x-codex-primary-used-percent`, `-window-minutes` and `-reset-at`
//   headers (and `secondary`) on a response (codex-api/src/rate_limits.rs:22-100).
// - A `codex.rate_limits` frame on the Responses websocket, the transport
//   OpenCode uses for ChatGPT (rate_limits.rs `parse_rate_limit_event`).
// It serves the pool what an auth plugin's quota RPC would (opencode/quota.ts's
// QuotaRpc), since OpenCode's ChatGPT login has none. A failed or refused read
// is no reading: the pace fails open, never holds. No token is kept or logged.
import { Cause, Clock, Effect, PubSub, Schema, Stream } from "effect"
import type { QuotaRpc } from "../opencode/quota.ts"
import { accountWide, type ClaimAnswer, type QuotaReading, type QuotaWindow, type ResetCredit } from "../quota.ts"

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

/** The reset credits' list beside a usage endpoint (codex-rs backend-client rate_limit_resets.rs). */
export const creditsUrl = (usageUrl: string) => usageUrl.replace(/\/usage$/, "/rate-limit-reset-credits")

/**
 * Where a reset credit is consumed (codex-rs backend-client
 * rate_limit_resets.rs `consume_rate_limit_reset_credit_url`), with
 * `{ redeem_request_id, credit_id }`; `redeem_request_id` is the idempotency key.
 */
export const consumeUrl = (usageUrl: string) => `${creditsUrl(usageUrl)}/consume`

/** How long a claim has to answer. */
const CLAIM_TIMEOUT_MS = 25_000

const CODES: Readonly<Record<string, ClaimAnswer["outcome"]>> = {
  reset: "reset",
  nothing_to_reset: "nothing-to-reset",
  no_credit: "no-credit",
  already_redeemed: "already-redeemed",
}

/**
 * A consume's answer, by its status and body (`{ code, windows_reset }`,
 * codex-rs backend-client types.rs `ConsumeRateLimitResetCreditResponse`):
 * 401 or 403 is a refused login, 429 rate limited, any other failure or an
 * unknown code failed.
 */
export const claimOf = (status: number, body: unknown): ClaimAnswer => {
  if (status === 401 || status === 403) return { outcome: "signed-out", message: `the claim was refused: ${status}` }
  if (status === 429) return { outcome: "rate-limited", message: "ChatGPT is rate limiting resets" }
  if (status < 200 || status >= 300) return { outcome: "failed", message: `the claim answered ${status}` }
  const code = isRecord(body) ? body.code : undefined
  const outcome = typeof code === "string" ? CODES[code] : undefined
  if (outcome === undefined) return { outcome: "failed", message: `the claim's answer does not read: ${JSON.stringify(code) ?? "none"}` }
  const windows = isRecord(body) && finite(body.windows_reset) ? `${body.windows_reset} windows reset` : undefined
  return { outcome, ...(windows === undefined ? (outcome === "reset" ? {} : { message: String(code) }) : { message: windows }) }
}

/** A held reading younger than this answers `reading` without asking the endpoint again. */
export const FRESH_MS = 60_000

/** How long the usage endpoint has to answer. */
const TIMEOUT_MS = 10_000

/** What a read of the usage endpoint needs of one login: its access token and its ChatGPT account. */
export interface Login {
  readonly access: string
  readonly accountID?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** The pool's name for a window of `minutes`: the 5-hour and the weekly windows by their usual names. */
export const windowName = (minutes: number) => (minutes === 300 ? "5h" : minutes === 10_080 ? "7d" : `${minutes}m`)

const window = (usedPercent: number, minutes: number | undefined, resetSeconds: number | undefined): QuotaWindow | undefined =>
  minutes === undefined || minutes <= 0
    ? undefined
    : {
        name: windowName(minutes),
        utilization: Math.min(Math.max(usedPercent / 100, 0), 1),
        ...(resetSeconds === undefined ? {} : { resetAt: resetSeconds * 1000 }),
      }

/**
 * A reading of `windows`, refused for its usage limit when the provider says
 * the limit is reached: until the last full window resets, else the first.
 */
const readingOf = (windows: ReadonlyArray<QuotaWindow>, now: number, reached: boolean): QuotaReading => {
  const full = windows.filter((w) => accountWide(w) && w.utilization >= 1).flatMap((w) => (w.resetAt === undefined ? [] : [w.resetAt]))
  const resets = windows.flatMap((w) => (w.resetAt === undefined ? [] : [w.resetAt]))
  const until = full.length ? Math.max(...full) : resets.length ? Math.min(...resets) : undefined
  return reached
    ? { at: now, status: "rejected", windows, refusal: { kind: "usage-limit", ...(until === undefined ? {} : { until }) } }
    : { at: now, status: "allowed", windows }
}

/** A usage answer's `rate_limit` windows, each named by its length and, for a model's own limit, `:<limit name>`. */
const usageWindows = (limit: unknown, scope?: string): ReadonlyArray<QuotaWindow> =>
  !isRecord(limit)
    ? []
    : [limit.primary_window, limit.secondary_window].flatMap((w) => {
        if (!isRecord(w) || !finite(w.used_percent) || !finite(w.limit_window_seconds)) return []
        const read = window(w.used_percent, Math.round(w.limit_window_seconds / 60), finite(w.reset_at) ? w.reset_at : undefined)
        return read === undefined ? [] : [scope === undefined ? read : { ...read, name: `${read.name}:${scope}` }]
      })

/**
 * The usage endpoint's answer as a reading; anything else is none. A model's
 * own limit (`additional_rate_limits`, by its `limit_name`; codex-rs
 * backend-client types.rs) reads as windows scoped to it (`7d:<limit name>`),
 * which never hold the account. The reset credits' count comes along when the
 * answer carries it (`rate_limit_reset_credits.available_count`).
 */
export const fromUsage = (body: unknown, now: number): QuotaReading | undefined => {
  if (!isRecord(body) || !isRecord(body.rate_limit)) return undefined
  const limit = body.rate_limit
  const windows = usageWindows(limit)
  if (!windows.length) return undefined
  const additional = (Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []).flatMap((extra) =>
    isRecord(extra) && typeof extra.limit_name === "string" && extra.limit_name !== "" ? usageWindows(extra.rate_limit, extra.limit_name) : [],
  )
  const reading = readingOf([...windows, ...additional], now, limit.limit_reached === true || limit.allowed === false)
  const credits = body.rate_limit_reset_credits
  return isRecord(credits) && finite(credits.available_count)
    ? { ...reading, resets: { available: Math.max(0, credits.available_count), credits: [] } }
    : reading
}

/**
 * A reading with the account's reset credits as their list answers
 * (`wham/rate-limit-reset-credits`): each credit's id, status and expiry, what
 * a claim needs. A malformed list leaves the reading as it was. Reading them
 * never claims one.
 */
export const withCredits = (reading: QuotaReading, body: unknown): QuotaReading => {
  if (!isRecord(body) || !Array.isArray(body.credits)) return reading
  const credits = body.credits.flatMap((credit): ReadonlyArray<ResetCredit> => {
    if (!isRecord(credit) || typeof credit.id !== "string" || typeof credit.status !== "string") return []
    const expiresAt = typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) : Number.NaN
    return [
      {
        id: credit.id,
        count: 1,
        usable: credit.status === "available",
        status: credit.status,
        ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      },
    ]
  })
  const ends = credits.flatMap((credit) => (credit.usable && credit.expiresAt !== undefined ? [credit.expiresAt] : []))
  const available = finite(body.available_count) ? Math.max(0, body.available_count) : credits.filter((credit) => credit.usable).length
  return { ...reading, resets: { available, ...(ends.length === 0 ? {} : { nextExpiresAt: Math.min(...ends) }), credits } }
}

const number = (text: string | null | undefined) => {
  if (text === null || text === undefined || text.trim() === "") return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** A response's `x-codex-*` rate-limit headers as a reading; none when it carries none. */
export const fromHeaders = (header: (name: string) => string | null, now: number): QuotaReading | undefined => {
  const windows = (["primary", "secondary"] as const).flatMap((which) => {
    const used = number(header(`x-codex-${which}-used-percent`))
    if (used === undefined) return []
    const read = window(used, number(header(`x-codex-${which}-window-minutes`)), number(header(`x-codex-${which}-reset-at`)))
    return read === undefined ? [] : [read]
  })
  return windows.length ? readingOf(windows, now, windows.some((w) => w.utilization >= 1)) : undefined
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A websocket frame as a reading, when it is a `codex.rate_limits` event; none otherwise. */
export const fromFrame = (frame: string, now: number): QuotaReading | undefined => {
  // Most frames are output deltas: only parse one that can be the event.
  if (!frame.includes("codex.rate_limits")) return undefined
  const parsed = parseJson(frame)
  if (parsed._tag === "None") return undefined
  const event = parsed.value
  if (!isRecord(event) || event.type !== "codex.rate_limits" || !isRecord(event.rate_limits)) return undefined
  const limits = event.rate_limits
  const windows = [limits.primary, limits.secondary].flatMap((w) => {
    if (!isRecord(w) || !finite(w.used_percent)) return []
    const read = window(w.used_percent, finite(w.window_minutes) ? w.window_minutes : undefined, finite(w.reset_at) ? w.reset_at : undefined)
    return read === undefined ? [] : [read]
  })
  return windows.length ? readingOf(windows, now, windows.some((w) => w.utilization >= 1)) : undefined
}

/** The ChatGPT quota source: the quota RPC the pool reads, and where the hooks hand it what a response showed. */
export interface Source {
  /** A QuotaRpc, typed as it answers. */
  readonly rpc: {
    readonly reading: (input: { readonly credentialID: string }) => Effect.Effect<{ readonly reading?: QuotaReading }>
    readonly usage: (input: { readonly credentialID: string }) => Effect.Effect<{ readonly reading?: QuotaReading }>
    readonly claim: (input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) => Effect.Effect<ClaimAnswer>
    readonly published: Stream.Stream<{ readonly credentialID: string; readonly reading: QuotaReading }>
  }
  /** A reading a response or frame of the login `credentialID` carried. */
  readonly observe: (credentialID: string, reading: QuotaReading) => Effect.Effect<void>
}

export interface Options {
  /** The login a credential id names, refreshed when it is about to expire; none when it is not a ChatGPT login. */
  readonly login: (credentialID: string) => Effect.Effect<Login | undefined, unknown>
  /** The usage endpoint; another one for tests. */
  readonly url?: string
  /** How a request reaches the endpoint: the platform's `fetch`, or a test's network. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export const make = (options: Options) =>
  Effect.gen(function* () {
    const send = options.fetch ?? fetch
    const held = new Map<string, QuotaReading>()
    const published = yield* PubSub.unbounded<{ readonly credentialID: string; readonly reading: QuotaReading }>()

    const keep = (credentialID: string, reading: QuotaReading) =>
      Effect.suspend(() => {
        const before = held.get(credentialID)
        if (before !== undefined && before.at > reading.at) return Effect.void
        held.set(credentialID, reading)
        return PubSub.publish(published, { credentialID, reading }).pipe(Effect.asVoid)
      })

    const headersOf = (login: Login) => ({
      authorization: `Bearer ${login.access}`,
      ...(login.accountID === undefined ? {} : { "chatgpt-account-id": login.accountID }),
      "user-agent": "codex-cli",
    })

    /** A GET of `url` with the login's token and account: its JSON, or none on a refusal. */
    const get = (url: string, login: Login) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise((signal) =>
          send(url, {
            headers: headersOf(login),
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          }),
        )
        if (!response.ok) return undefined
        const body: unknown = yield* Effect.tryPromise(() => response.json())
        return body
      })

    /**
     * A fresh read of the usage endpoint; none on any failure, a refusal or a
     * malformed answer. An account with reset credits has their list read too,
     * for what a claim needs; a failed list read keeps the count alone.
     */
    const fetchUsage = (credentialID: string) =>
      Effect.gen(function* () {
        const login = yield* options.login(credentialID)
        if (login === undefined) return undefined
        const url = options.url ?? USAGE_URL
        const usage = fromUsage(yield* get(url, login), yield* Clock.currentTimeMillis)
        if (usage === undefined) return undefined
        const reading =
          (usage.resets?.available ?? 0) > 0
            ? withCredits(usage, yield* get(creditsUrl(url), login).pipe(Effect.orElseSucceed(() => undefined)))
            : usage
        yield* keep(credentialID, reading)
        return reading
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    /** Consume one credit; never fails, a failure is its outcome. */
    const claim = (input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) =>
      Effect.gen(function* () {
        const login = yield* options.login(input.credentialID)
        if (login === undefined) return { outcome: "signed-out", message: "not a ChatGPT login" } satisfies ClaimAnswer
        const response = yield* Effect.tryPromise((signal) =>
          send(consumeUrl(options.url ?? USAGE_URL), {
            method: "POST",
            headers: { ...headersOf(login), "content-type": "application/json" },
            body: JSON.stringify({ redeem_request_id: input.requestID, credit_id: input.creditID }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(CLAIM_TIMEOUT_MS)]),
          }),
        )
        const body: unknown = response.ok ? yield* Effect.tryPromise(() => response.json()).pipe(Effect.orElseSucceed(() => undefined)) : undefined
        return claimOf(response.status, body)
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          return Effect.succeed<ClaimAnswer>({ outcome: "failed", message: error instanceof Error ? error.message : String(error) })
        }),
      )

    const rpc: Source["rpc"] = {
      claim,
      reading: ({ credentialID }) =>
        Effect.gen(function* () {
          const before = held.get(credentialID)
          if (before !== undefined && (yield* Clock.currentTimeMillis) - before.at < FRESH_MS) return { reading: before }
          const reading = (yield* fetchUsage(credentialID)) ?? before
          return reading === undefined ? {} : { reading }
        }),
      usage: ({ credentialID }) => fetchUsage(credentialID).pipe(Effect.map((reading) => (reading === undefined ? {} : { reading }))),
      published: Stream.fromPubSub(published),
    }

    return { rpc: rpc satisfies QuotaRpc, observe: keep } satisfies Source
  })

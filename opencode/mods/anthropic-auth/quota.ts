/**
 * What an Anthropic subscription account has left, as its responses and the
 * usage endpoint report it, and why one cannot take requests now. The pool
 * reads it over the quota protocol (`@dotfiles/opencode-pool/quota`, whose
 * types and wire contract this file reuses).
 *
 * Every `/v1/messages` response carries the unified rate-limit headers:
 * the account's status, the window that limits it, and the utilization and
 * reset of its 5-hour and 7-day windows. Resets are epoch seconds on the
 * wire and epoch milliseconds here. A rejected window counts as full until
 * its reset.
 */
import type { QuotaReading, QuotaRefusal, QuotaStatus, QuotaWindow } from "@dotfiles/opencode-pool/quota"
import { isRecord } from "./json.ts"
import type { RateLimitCategory } from "./rate-limit.ts"

export { quotaProtocol } from "@dotfiles/opencode-pool/quota"
export type { QuotaReading, QuotaRefusal, QuotaStatus, QuotaWindow } from "@dotfiles/opencode-pool/quota"

/** The most credentials whose newest reading is kept. */
export const MAX_QUOTA_CREDENTIALS = 256
/** A 401 holds the credential until the host refreshes it: this long before it expires. */
export const HOST_REFRESH_WINDOW_MS = 5 * 60_000
export const MIN_UNAUTHORIZED_HOLD_MS = 60_000
/**
 * A login whose token could not be resolved is retried after this long. A
 * refresh whose outcome was unclear is never resent (`refresh.ts`), so the
 * retry fails without a network call until the owner signs in again.
 */
export const SIGNIN_RETRY_MS = 30 * 60_000
/** How old a sourced login's usage reading may get before a sweep refreshes its token to read it. */
export const USAGE_REFRESH_AFTER_MS = 30 * 60_000
export const USAGE_PATH = "/api/oauth/usage"
export const USAGE_TIMEOUT_MS = 10_000
export const USAGE_MAX_BYTES = 64 * 1024

const STATUSES = new Set<string>(["allowed", "allowed_warning", "rejected"])
const isStatus = (value: string | null): value is QuotaStatus => value !== null && STATUSES.has(value)

function epochSecondsToMs(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

function fraction(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.min(parsed, 1)
}

const UNIFIED = "anthropic-ratelimit-unified-"
const WINDOW_OF_CLAIM: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
}

/**
 * The reading the unified headers carry, or `undefined` when they carry no
 * window and no status (an API-key or non-Anthropic response).
 */
export function readUnifiedQuota(headers: Headers, now: number): QuotaReading | undefined {
  const rawStatus = headers.get(`${UNIFIED}status`)
  const status = isStatus(rawStatus) ? rawStatus : undefined
  const claim = headers.get(`${UNIFIED}representative-claim`)
  const claimed = claim === null ? undefined : WINDOW_OF_CLAIM[claim]
  const windows: QuotaWindow[] = []
  for (const name of ["5h", "7d"]) {
    const utilization = fraction(headers.get(`${UNIFIED}${name}-utilization`))
    const resetAt = epochSecondsToMs(headers.get(`${UNIFIED}${name}-reset`))
    if (utilization === undefined && resetAt === undefined) continue
    // The window that rejected the account is full until it resets.
    const full = status === "rejected" && claimed === name
    windows.push({
      name,
      utilization: full ? 1 : (utilization ?? 0),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  }
  if (status === undefined && windows.length === 0) return undefined
  return { at: now, ...(status ? { status } : {}), windows }
}

/** When a rejected account takes requests again: the claimed window's reset, else the overall one. */
export function rejectedUntil(headers: Headers, reading: QuotaReading | undefined): number | undefined {
  if (reading?.status !== "rejected") return undefined
  const claim = headers.get(`${UNIFIED}representative-claim`)
  const claimed = claim === null ? undefined : WINDOW_OF_CLAIM[claim]
  const window = reading.windows.find((entry) => entry.name === claimed)
  return window?.resetAt ?? epochSecondsToMs(headers.get(`${UNIFIED}reset`))
}

/** `retry-after` as an epoch ms deadline: seconds, or an HTTP date. */
export function retryAfterUntil(headers: Headers, now: number): number | undefined {
  const raw = headers.get("retry-after")?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? date : undefined
}

const USAGE_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
}

/**
 * The usage endpoint's answer as a reading. It names each window with a
 * utilization in percent and an ISO reset; a window it reports as `null` is
 * left out. Windows beyond the 5-hour and 7-day ones keep their own names.
 */
export function readUsageBody(body: unknown, now: number): QuotaReading | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const windows: QuotaWindow[] = []
  for (const [key, record] of Object.entries(body)) {
    if (!isRecord(record)) continue
    if (typeof record.utilization !== "number") continue
    if (!Number.isFinite(record.utilization)) continue
    const resetAt = typeof record.resets_at === "string" ? Date.parse(record.resets_at) : Number.NaN
    windows.push({
      name: USAGE_WINDOWS[key] ?? key,
      utilization: Math.min(Math.max(record.utilization / 100, 0), 1),
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    })
  }
  if (windows.length === 0) return undefined
  return { at: now, windows }
}

/**
 * Why a refused response's credential cannot take requests, and until when:
 * a plan limit until the rejected window resets, a rate limit for its
 * `retry-after`, and a rejected token until the host refreshes it.
 */
export function refusalOf(input: {
  readonly status: number
  readonly category: RateLimitCategory | undefined
  readonly headers: Headers
  readonly quota: QuotaReading | undefined
  readonly now: number
  readonly expires: number | undefined
}): QuotaRefusal | undefined {
  if (input.status === 401) {
    return {
      kind: "unauthorized",
      until: Math.max(input.now + MIN_UNAUTHORIZED_HOLD_MS, (input.expires ?? 0) - HOST_REFRESH_WINDOW_MS),
    }
  }
  if (input.status !== 429) return undefined
  const rejected = rejectedUntil(input.headers, input.quota)
  const retryAfter = retryAfterUntil(input.headers, input.now)
  if (input.category === "subscription-usage" || input.quota?.status === "rejected") {
    const until = rejected ?? retryAfter
    return { kind: "usage-limit", ...(until === undefined ? {} : { until }) }
  }
  const until = retryAfter ?? rejected
  return { kind: "rate-limit", ...(until === undefined ? {} : { until }) }
}

/**
 * The soonest a refused login is free again: `until`, or an earlier end of
 * another refusal. A login no refusal holds is the pool's to fail over to.
 */
export function earliestRelease(readings: Iterable<QuotaReading>, until: number, now: number): number {
  let earliest = until
  for (const reading of readings) {
    const end = reading.refusal?.until
    if (end !== undefined && end > now && end < earliest) earliest = end
  }
  return earliest
}

/**
 * The longest `retry-after` a refused request answers with: OpenCode's own
 * cap on a provider's (`RETRY_AFTER_MAX` in its model retry).
 */
export const MAX_REFUSED_RETRY_AFTER_S = 15 * 60

/** `until` as a `retry-after`: whole seconds from `now`, at least one, at most the cap. */
export const retryAfterSeconds = (until: number, now: number): number =>
  Math.min(MAX_REFUSED_RETRY_AFTER_S, Math.max(1, Math.ceil((until - now) / 1000)))

/**
 * What a refused request answers: Anthropic's rate-limit error, which
 * OpenCode retries after `retry-after` (`x-should-retry` says so outright).
 * Its words name no quota, so it is never read as an exhausted plan.
 */
export const refusedBody = (retryAfter: number): string =>
  JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: `The pooled Anthropic login cannot be used for ${retryAfter}s (its token could not be refreshed now); the request is retried`,
    },
  })

export const refusedHeaders = (retryAfter: number): Record<string, string> => ({
  "content-type": "application/json",
  "retry-after": String(retryAfter),
  "x-should-retry": "true",
})

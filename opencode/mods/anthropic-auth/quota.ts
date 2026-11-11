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
import type { ClaimAnswer, QuotaReading, QuotaRefusal, QuotaResets, QuotaStatus, QuotaWindow, ResetCredit } from "@dotfiles/opencode-pool/quota"
import { grantKind } from "@dotfiles/opencode-pool/quota"
import { isRecord } from "./json.ts"
import type { RateLimitCategory } from "./rate-limit.ts"

export { quotaProtocol } from "@dotfiles/opencode-pool/quota"
export type { ClaimAnswer, ClaimOutcome, QuotaReading, QuotaRefusal, QuotaResets, QuotaStatus, QuotaWindow, ResetCredit } from "@dotfiles/opencode-pool/quota"

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
/**
 * Asks the usage endpoint for the account's reset grants too (`cedar_ember`,
 * as T3 Code's claudeResetCredits.ts reads them), and to leave out the spend
 * figures the pool does not read. The windows answer the same either way
 * (measured 2026-11-09).
 */
export const USAGE_QUERY = "cedar_ember=1&skip_spend=1"
export const USAGE_TIMEOUT_MS = 10_000
export const USAGE_MAX_BYTES = 64 * 1024

/** The login's profile, which names its organization (`organization.uuid`), as Claude Code reads it. */
export const PROFILE_PATH = "/api/oauth/profile"
/** Where a reset grant is claimed for an organization (Claude Code's and T3 Code's claudeResetCredits.ts). */
export const resetPath = (organization: string) => `/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`
/** The grant program the usage endpoint lists (`?cedar_ember=1`) and a claim names. */
export const RESET_PROGRAM = "cedar_ember"
/** A claim's time to answer; a claim that times out goes again under the same request id. */
export const RESET_TIMEOUT_MS = 25_000
/** A grant id and a request id as the endpoint takes them (T3 Code's checks). */
export const GRANT_ID = /^[a-z0-9_-]{1,40}$/
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The organization a profile body names; none when it names none. */
export const organizationOf = (body: unknown): string | undefined => {
  const organization = isRecord(body) ? body.organization : undefined
  const uuid = isRecord(organization) ? organization.uuid : undefined
  return typeof uuid === "string" && uuid.trim() !== "" ? uuid.trim() : undefined
}

const CLAIM_RESULTS: Readonly<Record<string, ClaimAnswer["outcome"]>> = {
  reset: "reset",
  not_limited: "nothing-to-reset",
  already_used: "already-redeemed",
  ineligible: "no-credit",
  cooldown: "cooldown",
  unavailable: "unconfirmed",
}

/**
 * A claim's answer, by its status and body: 429 is rate limited, 401 or 403
 * a login refused, another failure or an unknown `result` failed, else the
 * `result` in the pool's words.
 */
export const claimAnswerOf = (status: number, body: unknown): ClaimAnswer => {
  if (status === 429) return { outcome: "rate-limited", message: "Claude is rate limiting resets" }
  if (status === 401 || status === 403) return { outcome: "signed-out", message: `the claim was refused: ${status}` }
  if (status < 200 || status >= 300) return { outcome: "failed", message: `the claim answered ${status}` }
  const result = isRecord(body) ? body.result : undefined
  const outcome = typeof result === "string" ? CLAIM_RESULTS[result] : undefined
  return outcome === undefined
    ? { outcome: "failed", message: `the claim's answer does not read: ${JSON.stringify(result) ?? "none"}` }
    : { outcome, ...(typeof result === "string" && outcome !== "reset" ? { message: result } : {}) }
}

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

/** The window a `limits` entry's group is: a weekly one is `7d`, a session one `5h`. */
const LIMIT_GROUPS: Readonly<Record<string, string>> = {
  weekly: "7d",
  session: "5h",
}

const isoMs = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const percentWindow = (name: string, percent: unknown, resetsAt: unknown): QuotaWindow | undefined => {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined
  const resetAt = isoMs(resetsAt)
  return { name, utilization: Math.min(Math.max(percent / 100, 0), 1), ...(resetAt === undefined ? {} : { resetAt }) }
}

/**
 * Each model's own window, named `<window>:<model>` (`7d:Fable`). The
 * endpoint lists them in `limits` (a `weekly_scoped` entry with a model
 * scope, as read on 2026-11-09); the CLI's `model_scoped` (T3 Code's
 * claudeUsageLimits.ts) carries the weekly ones by display name. A model's
 * window is read once, `model_scoped` first.
 */
function modelWindows(body: Record<string, unknown>): ReadonlyArray<QuotaWindow> {
  const found = new Map<string, QuotaWindow>()
  const add = (window: QuotaWindow | undefined) => {
    if (window !== undefined && !found.has(window.name)) found.set(window.name, window)
  }
  for (const entry of Array.isArray(body.model_scoped) ? body.model_scoped : []) {
    if (isRecord(entry) && typeof entry.display_name === "string" && entry.display_name !== "")
      add(percentWindow(`7d:${entry.display_name}`, entry.utilization, entry.resets_at))
  }
  const limits = Array.isArray(body.limits) ? body.limits : []
  // `weekly_scoped_shares` names a `limits` entry by its index: its allowance, and the use it took, as percents of the weekly window.
  const shares = new Map<number, { ofWeekly?: number; weeklyUsed?: number }>()
  const share = (value: unknown, positive: boolean) =>
    typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0) ? Math.min(value / 100, 1) : undefined
  for (const entry of Array.isArray(body.weekly_scoped_shares) ? body.weekly_scoped_shares : []) {
    if (!isRecord(entry) || typeof entry.limit_index !== "number") continue
    const ofWeekly = share(entry.allowance_percent_of_weekly, true)
    const weeklyUsed = share(entry.used_percent_of_weekly, false)
    if (ofWeekly !== undefined || weeklyUsed !== undefined)
      shares.set(entry.limit_index, { ...(ofWeekly === undefined ? {} : { ofWeekly }), ...(weeklyUsed === undefined ? {} : { weeklyUsed }) })
  }
  limits.forEach((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.scope) || !isRecord(entry.scope.model)) return
    const model = entry.scope.model.display_name
    const group = typeof entry.group === "string" ? (LIMIT_GROUPS[entry.group] ?? entry.group) : undefined
    if (typeof model !== "string" || model === "" || group === undefined) return
    const window = percentWindow(`${group}:${model}`, entry.percent, entry.resets_at)
    add(window === undefined ? window : { ...window, ...shares.get(index) })
  })
  // A model's window `model_scoped` carried first takes the shares its `limits` entry names.
  for (const [index, shared] of shares) {
    const entry = limits[index]
    const model = isRecord(entry) && isRecord(entry.scope) && isRecord(entry.scope.model) ? entry.scope.model.display_name : undefined
    const name = typeof model === "string" ? `7d:${model}` : undefined
    const held = name === undefined ? undefined : found.get(name)
    if (name !== undefined && held !== undefined) found.set(name, { ...shared, ...held })
  }
  return [...found.values()]
}


/**
 * The reset grants of `cedar_ember` (asked for with `?cedar_ember=1`): each
 * grant's resets left, and the resets usable now (not paused, usable, not
 * ended). An account the program does not reach has none. Undefined when the
 * body has no such block. Reading them never claims one.
 */
function readResets(block: unknown, now: number): QuotaResets | undefined {
  if (!isRecord(block) || typeof block.eligible !== "boolean") return undefined
  if (!block.eligible) return { available: 0, credits: [] }
  const credits: ResetCredit[] = []
  for (const grant of Array.isArray(block.grants) ? block.grants : []) {
    if (!isRecord(grant) || typeof grant.id !== "string") continue
    const left = grant.resets_left
    if (typeof left !== "number" || !Number.isInteger(left) || left < 0) continue
    const expiresAt = isoMs(grant.ends_at)
    const usable = grant.paused !== true && grant.usable_now === true && (expiresAt === undefined || expiresAt > now)
    const clears = Array.isArray(grant.clears) ? grant.clears.filter((name): name is string => typeof name === "string") : undefined
    const givesBack = grant.gives_back_weekly === true
    credits.push({
      id: grant.id,
      count: left,
      usable,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(clears === undefined ? {} : { clears }),
      kind: grantKind({ clears: clears ?? [], type: grant.type, givesBack }),
      ...(givesBack ? { givesBack } : {}),
      // Claude Code reads a grant without the field as one that needs a limit.
      requiresLimit: grant.use_requires_limit !== false,
      ...(grant.paused === true ? { paused: true } : {}),
    })
  }
  const live = credits.filter((credit) => credit.usable && credit.count > 0)
  const ends = live.flatMap((credit) => (credit.expiresAt === undefined ? [] : [credit.expiresAt]))
  return {
    available: live.reduce((total, credit) => total + credit.count, 0),
    ...(ends.length === 0 ? {} : { nextExpiresAt: Math.min(...ends) }),
    credits,
  }
}

/**
 * The usage endpoint's answer as a reading. It names each window with a
 * utilization in percent and an ISO reset; a window it reports as `null` is
 * left out. Windows beyond the 5-hour and 7-day ones keep their own names,
 * and each model's own window is `<window>:<model>`. The reset grants come
 * along when the body carries them.
 */
export function readUsageBody(body: unknown, now: number): QuotaReading | undefined {
  if (!isRecord(body)) return undefined
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
  windows.push(...modelWindows(body))
  if (windows.length === 0) return undefined
  const resets = readResets(body.cedar_ember, now)
  return { at: now, windows, ...(resets === undefined ? {} : { resets }) }
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

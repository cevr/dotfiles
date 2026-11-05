// What an Anthropic 429 means (a plan limit, a request rate, fast-mode
// credits) and the diagnostic OpenCode shows for it: the category, the login
// it came on and Anthropic's request id, never the provider's own words.
// Logins are named by a random label or a fingerprint, never by a credential.
import { headersAfterBodyTransform } from "./content-headers.ts"
import { isRecord, parseJson } from "./json.ts"
import { sha256Hex } from "./sha256.ts"

export const MAX_RATE_LIMIT_BODY_BYTES = 64 * 1024
export const MAX_RATE_LIMIT_BODY_CHUNKS = 1024
const DEFAULT_RATE_LIMIT_PROBE_TIMEOUT_MS = 1000
const MAX_RATE_LIMIT_PROBE_TIMEOUT_MS = 5000
const SAFE_GENERATED_LABEL = /^Claude OAuth • [A-F0-9]{8}$/
const SAFE_GENERIC_LABEL = /^Anthropic(?: [1-9][0-9]{0,5})?$/
const SAFE_REQUEST_ID = /^req_[a-z0-9][a-z0-9_-]{0,91}$/i
const SAFE_OVERAGE_DISABLED_REASONS = new Set(["org_level_disabled"])
const SAFE_ERROR_TYPES = new Set(["rate_limit_error"])

export const UNKNOWN_CONNECTION = "Unknown OAuth connection"
export const AMBIGUOUS_CONNECTION = "Ambiguous OAuth connection"

export type RateLimitCategory = "fast-mode-credits" | "subscription-usage" | "transient-rate-limit" | "unknown-rate-limit"

export interface ConnectionInfo {
  readonly type: string
  readonly id?: string
  readonly label?: string
}

export function classifyRateLimit(message: string, errorType: unknown): RateLimitCategory {
  if (
    errorType === "rate_limit_error" &&
    /\bfast mode\b/i.test(message) &&
    /\b(?:usage credits?|extra usage)\b/i.test(message)
  ) {
    return "fast-mode-credits"
  }
  if (
    /\b(?:usage|weekly|monthly(?: spend)?|session|subscription|plan) limit\b/i.test(message) ||
    /\bquota exhausted\b/i.test(message) ||
    /\bextra usage (?:is )?required\b/i.test(message)
  ) {
    return "subscription-usage"
  }
  if (
    /\b(?:rate[- ]?limit(?:ed| exceeded| reached)?|too many requests|requests? per minute|tokens? per minute|acceleration limit|temporarily limiting requests)\b/i.test(
      message,
    )
  ) {
    return "transient-rate-limit"
  }
  return "unknown-rate-limit"
}

function canonicalMessage(category: RateLimitCategory): string {
  switch (category) {
    case "fast-mode-credits":
      return "Anthropic requires usage credits (extra usage) for fast mode on this account."
    case "subscription-usage":
      return "Anthropic reports that this account has reached a subscription or usage limit."
    case "transient-rate-limit":
      return "Anthropic reports a transient request rate limit."
    default:
      return "Anthropic returned an unclassified HTTP 429 response."
  }
}

function actionHint(category: RateLimitCategory): string {
  switch (category) {
    case "fast-mode-credits":
      return " Enable extra usage for the Anthropic account or organization, or use a model without fast mode."
    case "subscription-usage":
      return " Verify or explicitly switch the active Anthropic connection; no automatic account fallback was attempted."
    default:
      return ""
  }
}

/** How long a 429's body is read before it goes through as it came, in ms. */
export function probeTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RATE_LIMIT_PROBE_TIMEOUT_MS
  return Math.min(MAX_RATE_LIMIT_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(requested)))
}

function safeRequestID(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : undefined
}

function overageDisabledDiagnostic(headers: Headers): string | undefined {
  const value = headers.get("anthropic-ratelimit-unified-overage-disabled-reason")
  return value && SAFE_OVERAGE_DISABLED_REASONS.has(value) ? value : undefined
}

function retryAfterDiagnostic(headers: Headers): string | undefined {
  const value = headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 24 * 60 * 60) return `${seconds}s`
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return new Date(timestamp).toUTCString()
  return undefined
}

/** A label for a new login from 4 random bytes; none from fewer. */
export function createConnectionLabel(entropy: Uint8Array): string | undefined {
  const suffix = Array.from(entropy.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
  if (suffix.length !== 8) return undefined
  return `Claude OAuth • ${suffix}`
}

/** A login as a diagnostic names it: a safe label and a fingerprint of its id. */
export function describeConnection(connection: ConnectionInfo): string {
  if (connection.type !== "credential" || !connection.id) {
    return "Non-credential Anthropic connection"
  }
  const fingerprint = sha256Hex(connection.id).slice(0, 10)
  const label =
    typeof connection.label === "string" &&
    (SAFE_GENERIC_LABEL.test(connection.label) || SAFE_GENERATED_LABEL.test(connection.label))
      ? connection.label
      : "Custom label hidden"
  return `${label} [connection ${fingerprint}]`
}

export function isSubscriptionUsageDiagnostic(message: string): boolean {
  return message.startsWith("[anthropic-auth category=subscription-usage;")
}

/** A 429 rewritten as its diagnostic: the body and headers to answer with. */
export interface RateLimitDiagnostic {
  readonly category: RateLimitCategory
  readonly body: string
  readonly headers: Headers
}

/**
 * The diagnostic for a 429 whose whole body is `text`, on the login
 * `connection` describes; none when the body is not Anthropic's error shape.
 */
export function rateLimitDiagnostic(text: string, sent: Headers, connection: string): RateLimitDiagnostic | undefined {
  const root = parseJson(text)
  if (!isRecord(root)) return undefined
  const error = root.error
  if (!isRecord(error)) return undefined
  if (typeof error.message !== "string" || error.message.trim().length === 0) return undefined

  const category = classifyRateLimit(error.message, error.type)
  const headers = headersAfterBodyTransform(sent)
  headers.set("content-type", "application/json")
  if (category === "subscription-usage" || category === "fast-mode-credits") {
    headers.set("x-should-retry", "false")
  }

  for (const name of ["request-id", "x-request-id"]) {
    const value = headers.get(name)
    if (value && !safeRequestID(value)) headers.delete(name)
  }
  const retryAfter = retryAfterDiagnostic(headers)
  if (headers.has("retry-after") && !retryAfter) headers.delete("retry-after")
  const overageDisabled = category === "fast-mode-credits" ? overageDisabledDiagnostic(headers) : undefined
  const requestID =
    safeRequestID(headers.get("request-id")) ?? safeRequestID(headers.get("x-request-id")) ?? safeRequestID(root.request_id)
  const errorType = typeof error.type === "string" && SAFE_ERROR_TYPES.has(error.type) ? error.type : "rate_limit_error"
  const details = [
    `category=${category}`,
    `active=${connection}`,
    ...(retryAfter ? [`retry-after=${retryAfter}`] : []),
    ...(overageDisabled ? [`overage-disabled=${overageDisabled}`] : []),
    ...(requestID ? [`request-id=${requestID}`] : []),
  ]
  const message = `[anthropic-auth ${details.join("; ")}] ${canonicalMessage(category)}${actionHint(category)}`
  const body = JSON.stringify({
    type: "error",
    error: { type: errorType, message },
    ...(requestID ? { request_id: requestID } : {}),
  })
  return { category, body, headers }
}

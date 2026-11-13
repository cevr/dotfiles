// The Request and Response values the hooks build: the OAuth headers Claude
// Code sends, the credential and cache lifetime another plugin chose, and the refused request
// that answers as a retryable 429 without leaving the process.
import { Schema } from "effect"
import { betaHeader, REQUIRED_BETAS } from "../betas.ts"
import type { Endpoint } from "../endpoint.ts"
import { refusedBody, refusedHeaders } from "../quota.ts"
import { type CacheTTL, isCacheTTL } from "../request-body.ts"
import { formatUserAgent } from "../version.ts"

/**
 * The request header another plugin sets in `model.request` to choose the
 * credential a request goes out on: a connection id of the `anthropic`
 * integration. It never reaches Anthropic.
 */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"

/**
 * The request header another plugin sets in `model.request` to write the
 * request's cache for another lifetime than the one it carries: the pool's,
 * once a session has outlived its agent's own. It never reaches Anthropic.
 */
export const CACHE_TTL_HEADER = "x-opencode-cache-ttl"

/** The request without the cache-lifetime header, and the lifetime it named when Anthropic accepts it. */
export function takeCacheTTL(request: Request): {
  readonly request: Request
  readonly ttl: CacheTTL | undefined
} {
  const named = request.headers.get(CACHE_TTL_HEADER)?.trim()
  if (named === undefined) return { request, ttl: undefined }
  const headers = new Headers(request.headers)
  headers.delete(CACHE_TTL_HEADER)
  return { request: new Request(request, { headers }), ttl: isCacheTTL(named) ? named : undefined }
}

/** Where a refused request goes: nowhere. Fetching it answers at once, offline. */
export const REFUSED_URL = "data:text/plain,"

/** A copy of the request's headers. */
export function mergeHeaders(request: Request): Headers {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    headers.set(key, value)
  })
  return headers
}

/** Set the OAuth headers Claude Code sends: bearer, betas, user-agent; never an API key. */
export function setOAuthHeaders(headers: Headers, accessToken: string, version: string, modelID?: string): Headers {
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-beta", betaHeader(headers.get("anthropic-beta"), modelID))
  headers.set("user-agent", formatUserAgent(version))
  headers.delete("x-api-key")
  return headers
}

/** The request without the credential-choice header, and the id it named (an empty one names none). */
export function takeCredentialChoice(request: Request): {
  readonly request: Request
  readonly credentialID: string | undefined
} {
  const credentialID = request.headers.get(CREDENTIAL_HEADER)?.trim()
  if (credentialID === undefined) return { request, credentialID: undefined }
  const headers = new Headers(request.headers)
  headers.delete(CREDENTIAL_HEADER)
  return { request: new Request(request, { headers }), credentialID: credentialID === "" ? undefined : credentialID }
}

/** Whether a request has the shape this plugin gives a Messages request it sends with OAuth. */
export function hasTransformedOAuthShape(request: Request, endpoint: Endpoint): boolean {
  const url = new URL(request.url)
  const betas = new Set((request.headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim()))
  return (
    request.method === "POST" &&
    endpoint.isTrusted(url) &&
    request.headers.get("authorization")?.startsWith("Bearer ") === true &&
    REQUIRED_BETAS.every((beta) => betas.has(beta)) &&
    url.pathname === "/v1/messages"
  )
}

/** A request that goes nowhere in place of `request`. */
export const refusedRequest = (request: Request): Request =>
  new Request(REFUSED_URL, { method: "GET", signal: request.signal })

/** What a refused request answers: Anthropic's rate-limit error, retried after `retryAfter` seconds. */
export const refusedResponse = (retryAfter: number): Response =>
  new Response(refusedBody(retryAfter), { status: 429, headers: refusedHeaders(retryAfter) })

/**
 * What a request that could not be signed in answers: an authentication failure (401) with why, not retried by
 * itself; the pool fails the session over to another login on it.
 */
export const unsignedResponse = (message: string): Response =>
  new Response(encodeUnsigned({ type: "error", error: { type: "authentication_error", message } }), {
    status: 401,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  })

/** Anthropic's error envelope, as JSON text. */
const encodeUnsigned = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, error: Schema.Struct({ type: Schema.String, message: Schema.String }) })),
)

/**
 * The request routed to `url` (the endpoint's), as the hook rebuilds it: the
 * same request when the URL did not change.
 */
export const routed = (request: Request, url: URL): Request =>
  url.href === new URL(request.url).href ? request : new Request(url.toString(), request)

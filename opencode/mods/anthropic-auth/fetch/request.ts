// The Request and Response values the hooks build: the OAuth headers Claude
// Code sends, the credential another plugin chose, and the refused request
// that answers as a retryable 429 without leaving the process.
import { betaHeader, REQUIRED_BETAS } from "../betas.ts"
import type { Endpoint } from "../endpoint.ts"
import { refusedBody, refusedHeaders } from "../quota.ts"
import { formatUserAgent } from "../version.ts"

/**
 * The request header another plugin sets in `model.request` to choose the
 * credential a request goes out on: a connection id of the `anthropic`
 * integration. It never reaches Anthropic.
 */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"

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
 * The request routed to `url` (the endpoint's), as the hook rebuilds it: the
 * same request when the URL did not change.
 */
export const routed = (request: Request, url: URL): Request =>
  url.href === new URL(request.url).href ? request : new Request(url.toString(), request)

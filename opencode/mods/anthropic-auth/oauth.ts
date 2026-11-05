// The Claude Pro/Max sign-in (OAuth with PKCE, code pasted back) and the
// token grants it and every refresh make, checked before anything trusts them.
import { isRecord } from "./json.ts"
import { hex } from "./sha256.ts"
import { isBoundedUtf8 } from "./utf8.ts"

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export const AUTHORIZE_URLS = {
  console: "https://platform.claude.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize",
} as const

export const CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback"

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]

/** The integration this plugin signs in to. */
export const INTEGRATION_ID = "anthropic"
/** The sign-in method's id: a credential it made carries it. */
export const METHOD_ID = "claude-max"
export const METHOD_LABEL = "Claude Pro/Max"
export const AUTHORIZE_INSTRUCTIONS = "Paste the authorization code here:"
export const EXCHANGE_FAILED_MESSAGE =
  "Failed to exchange the Claude Pro/Max authorization code. " + "Double-check that you pasted the full code and try again."

export const TOKEN_TIMEOUT_MS = 30_000
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 8 * 1024
const MAX_CALLBACK_INPUT_BYTES = 16 * 1024
const MAX_VERIFIER_BYTES = 1024
const MAX_REDIRECT_URI_BYTES = 2 * 1024

/** The headers a token request carries: Claude Code's own HTTP client. */
export const TOKEN_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "User-Agent": "axios/1.13.6",
} as const

/** A token grant, checked: tokens to send and when the access token expires (epoch ms). */
export interface TokenGrant {
  readonly refresh: string
  readonly access: string
  readonly expires: number
}

/** An OAuth credential as OpenCode keeps it. */
export interface OAuthCredential extends TokenGrant {
  readonly type: "oauth"
  readonly methodID: string
}

export const toCredential = (grant: TokenGrant): OAuthCredential & { readonly methodID: typeof METHOD_ID } => ({
  type: "oauth",
  methodID: METHOD_ID,
  refresh: grant.refresh,
  access: grant.access,
  expires: grant.expires,
})

export interface CallbackParams {
  readonly code: string
  readonly state: string
}

/** An OAuth state from 16 random bytes: 32 hex characters, shaped as a version-4 UUID's. */
export function stateFrom(entropy: Uint8Array): string {
  const bytes = Uint8Array.from(entropy.slice(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return hex(bytes)
}

/** The URL the owner opens to sign in. */
export function authorizationUrl(mode: keyof typeof AUTHORIZE_URLS, challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URLS[mode])
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", CODE_CALLBACK_URL)
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "))
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url.toString()
}

/** The code and state the owner pasted: a callback URL, `code#state`, or a query string. */
export function parseCallbackInput(input: string): CallbackParams | undefined {
  const trimmed = input.trim()

  if (URL.canParse(trimmed)) {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (code && state) return { code, state }
  }

  const hashSplits = trimmed.split("#")
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get("code")
  const state = params.get("state")
  if (code && state) return { code, state }

  return undefined
}

/**
 * The callback to exchange, when the pasted input, the verifier and the
 * redirect are bounded and the state is the one the sign-in sent.
 */
export function exchangeCallback(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): CallbackParams | undefined {
  if (
    !isBoundedUtf8(input, MAX_CALLBACK_INPUT_BYTES) ||
    !isBoundedUtf8(verifier, MAX_VERIFIER_BYTES) ||
    !isBoundedUtf8(redirectUri, MAX_REDIRECT_URI_BYTES) ||
    (expectedState !== undefined && !isBoundedUtf8(expectedState, MAX_TOKEN_LENGTH))
  ) {
    return undefined
  }
  const callback = parseCallbackInput(input)
  if (!callback) return undefined
  if (expectedState && callback.state !== expectedState) return undefined
  if (!isBoundedUtf8(callback.code, MAX_TOKEN_LENGTH) || !isBoundedUtf8(callback.state, MAX_TOKEN_LENGTH)) {
    return undefined
  }
  return callback
}

/** Whether a refresh token is one a refresh may send. */
export const isSendableRefreshToken = (token: string): boolean => isBoundedUtf8(token, MAX_TOKEN_LENGTH)

export const exchangeBody = (callback: CallbackParams, verifier: string, redirectUri: string): string =>
  JSON.stringify({
    code: callback.code,
    state: callback.state,
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })

export const refreshBody = (refreshToken: string): string =>
  JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID })

/** The token endpoint's answer as a grant, when every token is bounded and the lifetime is a positive whole number. */
export function readTokenGrant(value: unknown, now: number): TokenGrant | undefined {
  if (!isRecord(value)) return undefined
  const { refresh_token, access_token, expires_in } = value
  if (
    typeof refresh_token !== "string" ||
    !isBoundedUtf8(refresh_token, MAX_TOKEN_LENGTH) ||
    typeof access_token !== "string" ||
    !isBoundedUtf8(access_token, MAX_TOKEN_LENGTH) ||
    typeof expires_in !== "number" ||
    !Number.isSafeInteger(expires_in) ||
    expires_in <= 0
  ) {
    return undefined
  }
  const expires = now + expires_in * 1000
  if (!Number.isSafeInteger(expires)) return undefined
  return { refresh: refresh_token, access: access_token, expires }
}

/**
 * Whether a refresh's outcome is unclear: the token may have been consumed
 * (no answer, a 5xx, or a 2xx whose grant could not be read), so it must
 * never be sent again.
 */
export const isAmbiguousRefreshFailure = (status: number): boolean =>
  status === 0 || status >= 500 || (status >= 200 && status < 300)

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])

/** Whether a failed token request failed on the network (a timeout, a reset): it got no answer. */
export function isTransientNetworkError(error: unknown): boolean {
  const seen = new WeakSet<object>()
  let current: unknown = error

  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false
    if (seen.has(current)) return false
    seen.add(current)

    if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) return true
    if ("code" in current && typeof current.code === "string" && TRANSIENT_CODES.has(current.code)) return true

    const message = current instanceof Error ? current.message.toLowerCase() : ""
    if (
      message === "fetch failed" ||
      message === "terminated" ||
      message === "network error" ||
      message.includes("socket hang up") ||
      message.includes("other side closed")
    ) {
      return true
    }

    if (!("cause" in current)) return false
    current = current.cause
  }

  return false
}

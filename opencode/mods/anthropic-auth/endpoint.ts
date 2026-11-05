// Where an OAuth request may go: Anthropic's API, or the exact origin of a
// validated custom endpoint (`ANTHROPIC_BASE_URL`, read by the composition root).

export const OFFICIAL_API = "https://api.anthropic.com"

/** The environment the endpoint comes from: raw values, as the process holds them. */
export interface EndpointEnv {
  /** `ANTHROPIC_BASE_URL`. */
  readonly baseUrl?: string | undefined
  /** `ANTHROPIC_INSECURE`. */
  readonly insecure?: string | undefined
}

const parseUrl = (raw: string): URL | undefined => (URL.canParse(raw) ? new URL(raw) : undefined)

/** The configured custom endpoint, without accepting embedded credentials or plain HTTP off loopback. */
export function resolveBaseUrl(raw: string | undefined): URL | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const baseUrl = parseUrl(trimmed)
  if (baseUrl === undefined) return undefined
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username || baseUrl.password) {
    return undefined
  }
  const loopback = baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "[::1]"
  if (baseUrl.protocol === "http:" && !loopback) return undefined
  return baseUrl
}

export interface Endpoint {
  /** Whether TLS verification was explicitly requested off for a custom endpoint (which a plugin cannot honour). */
  readonly insecure: boolean
  /** An API path on the custom endpoint's origin, or on the official API's when none is configured (or it is invalid). */
  readonly apiUrl: (path: string) => URL
  /** Whether OAuth bearer credentials may go to `input`. */
  readonly isTrusted: (input: string | URL) => boolean
  /**
   * The URL a request to `url` goes out on: the custom endpoint's origin with
   * the original path and query, and `?beta=true` on `/v1/messages`.
   */
  readonly route: (url: URL) => URL
}

export function makeEndpoint(env: EndpointEnv): Endpoint {
  const baseUrl = resolveBaseUrl(env.baseUrl)
  const configuredOrigin = baseUrl?.origin
  const insecureRaw = env.insecure?.trim()
  return {
    insecure: Boolean(env.baseUrl?.trim()) && (insecureRaw === "1" || insecureRaw === "true"),
    apiUrl: (path) => new URL(path, configuredOrigin ?? OFFICIAL_API),
    isTrusted: (input) => {
      const url = parseUrl(input.toString())
      return (
        url !== undefined &&
        url.username === "" &&
        url.password === "" &&
        (url.origin === OFFICIAL_API || (configuredOrigin !== undefined && url.origin === configuredOrigin))
      )
    },
    route: (url) => {
      const routed = new URL(url.href)
      if (baseUrl) {
        routed.protocol = baseUrl.protocol
        routed.host = baseUrl.host
      }
      if (routed.pathname === "/v1/messages" && !routed.searchParams.has("beta")) {
        routed.searchParams.set("beta", "true")
      }
      return routed
    },
  }
}

// How long a provider keeps a request's prompt cached: the lifetime a cache
// miss is judged by. A step that starts after the lifetime ran out since the
// previous request started paid for an expiry; one inside it paid for a
// changed prefix.

/** Which provider's caching rules a model follows. */
export type CacheFamily = "anthropic" | "openai"

/**
 * The lifetime each family's cache keeps a prompt when the request names none.
 *
 * - Anthropic caches explicitly: the request marks breakpoints with
 *   `cache_control: { type: "ephemeral" }`, and an ephemeral entry lives 5
 *   minutes, refreshed on each read ("The cache has a minimum 5-minute
 *   lifetime", docs.anthropic.com, Prompt caching). The fork sends a `ttl`
 *   only when the model's or provider's `settings.cache.ttl` names one
 *   (packages/core/src/session/model-request.ts:308, lowered at
 *   packages/ai/src/protocols/anthropic-messages.ts:544); otherwise
 *   Anthropic's 5-minute default applies.
 * - OpenAI caches implicitly: a prompt of 1,024 tokens or more is cached with
 *   no marker, and "cached prefixes generally remain active for 5 to 10
 *   minutes of inactivity" (platform.openai.com, Prompt caching). In practice
 *   it lasts longer: gent measured 238 of 244 requests after a 5-10 minute gap
 *   and 108 of 110 after a 10-30 minute gap still reading it
 *   (gent packages/extensions/src/providers.ts:856, RESPONSES_PROMPT_CACHE_TTL).
 *   30 minutes is that measured guess. Since OpenAI reports no cache writes,
 *   a miss inside it is never called a changed prefix (miss.ts).
 */
export const DEFAULT_TTL_MS: Readonly<Record<CacheFamily, number>> = {
  anthropic: 5 * 60_000,
  openai: 30 * 60_000,
}

/** The family of a model by its provider, else by its id; undefined for one this table does not know. */
export const familyOf = (providerID: string, modelID: string): CacheFamily | undefined => {
  if (providerID === "anthropic" || /claude/i.test(modelID)) return "anthropic"
  if (providerID === "openai" || /^(gpt-|o\d|codex)/i.test(modelID)) return "openai"
  return undefined
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** A `settings.cache.ttl` (`5m`, `1h`, `30s`, models.dev's duration format) in milliseconds; undefined when it does not parse. */
export const parseTtl = (ttl: string): number | undefined => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl)
  if (match === null) return undefined
  const [, amount = "", unit = ""] = match
  const scale = unit === "ms" || unit === "s" || unit === "m" || unit === "h" || unit === "d" ? UNIT_MS[unit] : undefined
  return scale === undefined ? undefined : Number(amount) * scale
}

/** What names a model's cache lifetime: its family, and the `settings.cache.ttl` its model or provider sets. */
export interface CacheTerms {
  readonly providerID: string
  readonly modelID: string
  /** The model's `settings.cache.ttl`, which wins over the provider's. */
  readonly modelTtl?: string
  readonly providerTtl?: string
}

/**
 * The lifetime a model's requests ask for: the model's `settings.cache.ttl`,
 * else its provider's (the fork resolves the two the same way,
 * packages/core/src/model-resolver.ts:487), else its family's default.
 * Undefined for a model of no known family and no setting: then only a model
 * switch counts as a miss.
 */
export const lifetimeMs = (terms: CacheTerms): number | undefined => {
  for (const ttl of [terms.modelTtl, terms.providerTtl]) {
    const parsed = ttl === undefined ? undefined : parseTtl(ttl)
    if (parsed !== undefined) return parsed
  }
  const family = familyOf(terms.providerID, terms.modelID)
  return family === undefined ? undefined : DEFAULT_TTL_MS[family]
}

/** What the catalog says of one model's lifetime: how long, and whether its or its provider's settings name it. */
export interface ModelLifetime {
  readonly lifetimeMs?: number
  /** The model's or provider's `settings.cache.ttl` names the lifetime, rather than the family's default. */
  readonly configured?: boolean
}

/**
 * The lifetime an agent's requests on a model ask for. An agent's own
 * `request.settings.cacheTTL` (an orchestration role's "5m") replaces a
 * lifetime the model's or provider's settings name, and nothing else: on a
 * model with no setting the provider's default stands, and a value that is
 * no duration changes nothing (the fork's rule,
 * packages/core/src/session/agent-cache.ts:17-20).
 */
export const agentLifetimeMs = (model: ModelLifetime | undefined, agentTtl: string | undefined): number | undefined => {
  const own = agentTtl === undefined ? undefined : parseTtl(agentTtl)
  return model?.configured === true && own !== undefined ? own : model?.lifetimeMs
}

// How long a provider keeps a prompt's cached prefix, and how long before
// that an idle session compacts.
//
// What our requests ask for: OpenCode sends a lifetime only when the model's
// or its provider's settings set `cache.ttl` (the fork's
// packages/core/src/session/model-request.ts:308, resolved from the merged
// provider and model settings at packages/core/src/model-resolver.ts:462,487).
// Without it the Anthropic protocol marks breakpoints `{ type: "ephemeral" }`
// with no `ttl` (packages/ai/src/cache-policy.ts:82-83,
// packages/ai/src/protocols/anthropic-messages.ts:544), so the provider's
// default lifetime applies. Neither our config nor mods/anthropic-auth sets one.
//
// The defaults, when nothing is configured:
// - Anthropic: 5 minutes, refreshed by each read; "1h" when asked for.
//   "The lifetime is measured from the start of the request that writes or
//   reads the cache entry, not from the end of its response."
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
// - OpenAI, GPT-5.6 and later: a 30-minute minimum lifetime by default
//   (`prompt_cache_options.ttl`), and "a 30-minute read refreshes coverage to
//   at least 30 minutes after that read".
//   https://developers.openai.com/api/docs/guides/prompt-caching
// - OpenAI, earlier models: `in_memory` entries "typically remain active for
//   around 5 to 10 minutes of inactivity"; the lower bound is taken.
//   (same page, "Cache lifetime")
// - Any other provider: unknown, so no idle compaction unless the plugin's
//   `ttlSeconds` option or the model's `cache.ttl` names one.
import { Option } from "effect"

const SECOND = 1_000
const MINUTE = 60 * SECOND

const UNITS: Readonly<Record<string, number>> = { ms: 1, s: SECOND, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }

/** A lifetime as OpenCode's `cache.ttl` writes it ("5m", "1h", "30s", "24h"), in milliseconds. None when it is not one. */
export const parseTTL = (text: string): Option.Option<number> => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (match === null) return Option.none()
  const [, amount, unit] = match
  const scale = unit === undefined ? undefined : UNITS[unit]
  if (amount === undefined || scale === undefined) return Option.none()
  const ms = Number(amount) * scale
  return ms > 0 ? Option.some(ms) : Option.none()
}

/** The model a request ran on, as far as its cache lifetime depends on it. */
export interface CachedModel {
  readonly providerID: string
  /** The provider the model's catalog entry is canonically from, when OpenCode knows it. */
  readonly canonical?: string | undefined
  readonly modelID: string
  /** The model's or its provider's `cache.ttl` setting, when one is configured. */
  readonly configured?: string | undefined
}

/** Anthropic's default lifetime. */
export const ANTHROPIC_DEFAULT = 5 * MINUTE
/** OpenAI's default for GPT-5.6 and later. */
export const OPENAI_DEFAULT = 30 * MINUTE
/** OpenAI's `in_memory` lifetime for earlier models, at its lower bound. */
export const OPENAI_IN_MEMORY = 5 * MINUTE

/** Whether an OpenAI model id names GPT-5.6 or later (`gpt-5.6`, `gpt-6.1-sol`, `openai/gpt-5.6-mini`). */
const gpt56OrLater = (modelID: string): boolean => {
  const match = /(?:^|\/)gpt-(\d+)(?:\.(\d+))?/.exec(modelID)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? "0")
  return major > 5 || (major === 5 && minor >= 6)
}

/** The provider's default lifetime for `model` when nothing is configured; none for a provider whose lifetime is unknown. */
export const defaultTTL = (model: CachedModel): Option.Option<number> => {
  const provider = model.canonical ?? model.providerID
  if (provider === "anthropic") return Option.some(ANTHROPIC_DEFAULT)
  if (provider === "openai") return Option.some(gpt56OrLater(model.modelID) ? OPENAI_DEFAULT : OPENAI_IN_MEMORY)
  return Option.none()
}

/** The lifetime a request on `model` gets: the configured `cache.ttl` when it parses, else the provider's default. */
export const ttlOf = (model: CachedModel): Option.Option<number> =>
  Option.orElse(model.configured === undefined ? Option.none() : parseTTL(model.configured), () => defaultTTL(model))

/** The margins before expiry: `short` for a cache of five minutes or less, `long` for a longer one. */
export interface Margins {
  readonly short: number
  readonly long: number
}

/** The longest lifetime the short margin applies to. */
export const SHORT_CACHE = 5 * MINUTE

/** How long before a cache of `ttl` expires an idle session compacts. */
export const marginOf = (ttl: number, margins: Margins): number => (ttl <= SHORT_CACHE ? margins.short : margins.long)

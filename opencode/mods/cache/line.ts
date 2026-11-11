// What the cache mod draws, as text: a transcript row for a large miss
// (`cache miss · 48k tokens · $0.31 · expired during a 6m shell call`) and
// the sidebar line for a session family (`Cache 91% · missed $0.42 · expired`).
import type { Cause, Miss } from "./miss.ts"

/** A row shows only a miss this large, in tokens or in dollars; the sidebar's total counts every miss. */
export const ROW_MIN_TOKENS = 20_000
export const ROW_MIN_USD = 0.1

/** A cost under this is not named: it rounds to nothing. */
const MIN_NAMED_USD = 0.01

/** pi's rule, as gent's: a row for a miss of at least 20k tokens or 10 cents. */
export const showsRow = (miss: Miss, costUsd: number): boolean => miss.missedTokens >= ROW_MIN_TOKENS || costUsd >= ROW_MIN_USD

/** `850`, `48k`, `1.2M`. */
export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** `12s`, `6m`, `1h 5m`. */
export const formatAge = (ms: number): string => {
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`
}

/** `$0.31`; a dollar or more keeps two decimals too. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`

export const causeText = (cause: Cause): string => {
  switch (cause._tag) {
    case "ModelSwitch":
      return "after a model switch"
    case "PrefixChanged":
      return cause.change === undefined
        ? "prefix changed inside the cache lifetime"
        : `prefix changed at ${cause.change.segment}, ${formatTokens(cause.change.offsetTokens)} tokens in`
    case "Lost":
      return "the cache lost an unchanged prefix"
    case "Compaction":
      return cause.request ? "the compaction request missed the cached prefix" : "a compaction rewrote the prefix"
    case "LoginMoved":
      return "the pool moved it to another login"
    case "Response":
      return `expired during a ${formatAge(cause.ms)} response`
    case "Tool":
      return `expired during a ${formatAge(cause.ms)} ${cause.toolName} call`
    case "Approval":
      return `expired waiting ${formatAge(cause.ms)} for approval`
    case "Paused":
      return `expired while the turn paused ${formatAge(cause.ms)}`
    case "Child":
      return `expired while a subagent ran ${formatAge(cause.ms)}`
    case "Idle":
      return `expired after ${formatAge(cause.ms)} idle`
  }
}

/** A cause in the sidebar's few words: every expiry reads `expired`, a changed prefix names its segment. */
export const shortCause = (cause: Cause): string => {
  switch (cause._tag) {
    case "ModelSwitch":
      return "model switch"
    case "PrefixChanged":
      return cause.change === undefined ? "prefix changed" : `prefix at ${cause.change.segment}`
    case "Lost":
      return "cache lost"
    case "Compaction":
      return "compaction"
    case "LoginMoved":
      return "login moved"
    case "Response":
    case "Tool":
    case "Approval":
    case "Paused":
    case "Child":
    case "Idle":
      return "expired"
  }
}

/** `cache miss · 48k tokens · $0.31 · expired during a 6m shell call`; a cent or less is not named. */
export const missText = (miss: Miss, costUsd: number): string =>
  ["cache miss", `${formatTokens(miss.missedTokens)} tokens`, ...(costUsd >= MIN_NAMED_USD ? [formatUsd(costUsd)] : []), causeText(miss.cause)].join(" · ")

/** A session family's prompt tokens and the part the cache served. */
export interface Hits {
  readonly promptTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * The share of `hits`' prompt tokens the cache served, in whole percent,
 * rounded down (99.6% is not every token). Undefined without cache activity
 * (no read and no write): a provider that reports none would read as 0%.
 * The sidebar line and Prime's tray both read it.
 */
export const cacheShare = (hits: Hits): number | undefined => {
  if (hits.promptTokens <= 0 || hits.cacheReadTokens + hits.cacheWriteTokens <= 0) return undefined
  return Math.floor((hits.cacheReadTokens * 100) / hits.promptTokens)
}

/**
 * The sidebar line: the share of the family's prompt tokens the cache served,
 * rounded down (99.6% is not every token), and what its misses cost, when they
 * cost a cent or more, with the cause that cost the most (`shortCause`) when
 * one is named. Nothing for a family that never reported cache activity: a
 * provider that reports none would read as 0%.
 */
export const sidebarText = (hits: Hits, missedUsd: number, cause?: string): string | undefined => {
  const percent = cacheShare(hits)
  if (percent === undefined) return undefined
  const share = `Cache ${percent}%`
  if (missedUsd < MIN_NAMED_USD) return share
  return [share, `missed ${formatUsd(missedUsd)}`, ...(cause === undefined ? [] : [cause])].join(" · ")
}

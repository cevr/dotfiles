// What a cache miss cost over a cache hit, from the model's catalog prices
// (`ModelInfo.cost`, USD per million tokens).
import type { CacheFamily } from "./ttl.ts"

/** One price entry of a model, in USD per million tokens; a `tier` entry applies above that many prompt tokens. */
export interface Rate {
  readonly tier?: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * The entry a request of `promptTokens` is billed by: the largest tier it
 * passes, else the untiered entry. The fork picks the same way when it prices
 * a step (packages/core/src/session/usage.ts:22-28).
 */
export const rateFor = (rates: ReadonlyArray<Rate>, promptTokens: number): Rate | undefined => {
  const tiered = rates
    .filter((rate) => rate.tier !== undefined && promptTokens > rate.tier)
    .toSorted((a, b) => (b.tier ?? 0) - (a.tier ?? 0))[0]
  return tiered ?? rates.find((rate) => rate.tier === undefined)
}

/** Anthropic bills a 1-hour cache write at twice the input rate; the catalog lists the 5-minute write (1.25×). */
const ANTHROPIC_HOUR_WRITE = 2
const HOUR_MS = 3_600_000

/**
 * The rate a cache write paid. The catalog's write price is Anthropic's
 * 5-minute one; a request that asks for an hour pays twice the input rate
 * (docs.anthropic.com, Prompt caching, Pricing).
 */
export const writeRate = (rate: Rate, family: CacheFamily | undefined, lifetimeMs: number | undefined): number =>
  family === "anthropic" && lifetimeMs !== undefined && lifetimeMs >= HOUR_MS ? rate.input * ANTHROPIC_HOUR_WRITE : rate.cacheWrite

/** The tokens a miss re-billed, and the step's cache writes it filled first. */
export interface Billed {
  readonly missedTokens: number
  readonly cacheWriteTokens: number
}

/**
 * What the miss cost over a cache hit. The re-billed prefix was written to the
 * cache again, so the missed tokens fill this step's cache writes first, at
 * the write rate; the rest paid the uncached input rate. Each part is priced
 * over the cache-read rate it would have paid. A provider that bills no writes
 * (OpenAI) reports none, so every missed token paid the input rate. No rate
 * (the catalog does not price the model) costs nothing.
 */
export const missCostUsd = (billed: Billed, rate: Rate | undefined, write: number): number => {
  if (rate === undefined) return 0
  const rewritten = Math.min(billed.missedTokens, billed.cacheWriteTokens)
  const uncached = Math.max(0, billed.missedTokens - rewritten)
  return (rewritten * Math.max(0, write - rate.cacheRead) + uncached * Math.max(0, rate.input - rate.cacheRead)) / 1_000_000
}

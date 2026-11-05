// Whether compacting an idle session costs less than letting its cache expire,
// from the model's catalog prices (`Model.Info.cost`, USD per million tokens;
// the fork's packages/schema/src/model.ts:92-104,130, read in
// opencode/sessions.ts). No guess at whether the session comes back: both sides
// price the next request as if it does.
//
// - Avoided: the next request writes the whole prompt again, at the write rate.
// - Cost: the summary request reads the prompt from cache and writes the
//   summary at the output rate, and the next request writes the summary's
//   prompt at the write rate.
//
// The summary's sizes are fixed estimates, set above what past compactions
// measured (Opus 5.5, 96 completed summaries on two machines, 2026-11-05):
// - its output, reasoning included: p50 5.5k, p90 39.6k, max 52.6k on one
//   machine; p90 5.8k, max 6.2k on the other. `SUMMARY_OUTPUT` is 32k, the
//   output the fork's compaction leaves a summary at the least
//   (`SUMMARY_OUTPUT_FLOOR`, packages/core/src/session/compaction.ts:148).
// - the first request on top of it, the new message included: p90 68k-70k.
//   The system prompt and tools are 21k-28k of that, and the summary's text is
//   in the output above; `SUMMARY_PROMPT` is 64k.
//
// On Opus 5.5 (catalog: input $4, output $20, cache read $0.20, write $5 for
// five minutes) with a one-hour cache (written at $8), compacting pays above
// (32k * 20 + 64k * 8) / (8 - 0.2) = 147.7k prompt tokens; with a five-minute
// cache, above 200k.
import { Option } from "effect"

/** One price entry of a model, in USD per million tokens; a `tier` entry applies above that many prompt tokens. */
export interface Rate {
  readonly tier?: number | undefined
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** A model's prices, as its catalog entry lists them. */
export interface Price {
  readonly rates: ReadonlyArray<Rate>
  /** The model is Anthropic's, which bills a one-hour cache write above the catalog's write price. */
  readonly anthropic: boolean
}

/** What the next request pays either way, in USD. */
export interface Bill {
  /** Left to expire: the next request writes the whole prompt again. */
  readonly avoided: number
  /** Compacted: the summary request, and the next request writing the summary's prompt. */
  readonly cost: number
  /** The prompt size, in tokens, above which compacting costs less. None when it never does. */
  readonly breakEven: Option.Option<number>
}

/** The summary's output, reasoning included, in tokens. */
export const SUMMARY_OUTPUT = 32_000
/** The prompt of the first request on top of the summary, in tokens. */
export const SUMMARY_PROMPT = 64_000

const MILLION = 1_000_000
const HOUR_MS = 3_600_000
/** Anthropic bills a one-hour cache write at twice the input rate; the catalog lists the five-minute write (1.25x). */
const ANTHROPIC_HOUR_WRITE = 2

/**
 * The entry a request of `promptTokens` is billed by: the largest tier it
 * passes, else the untiered entry. The fork picks the same way when it prices
 * a step (packages/core/src/session/usage.ts:23-34).
 */
export const rateFor = (rates: ReadonlyArray<Rate>, promptTokens: number): Rate | undefined => {
  const tiered = rates
    .filter((rate) => rate.tier !== undefined && promptTokens > rate.tier)
    .toSorted((a, b) => (b.tier ?? 0) - (a.tier ?? 0))[0]
  return tiered ?? rates.find((rate) => rate.tier === undefined)
}

/**
 * What a token written to the cache costs. An Anthropic one-hour write is
 * twice the input rate (https://platform.claude.com/docs/en/build-with-claude/prompt-caching,
 * Pricing); a provider that bills no writes (OpenAI) bills the token as input.
 */
export const writeRate = (rate: Rate, anthropic: boolean, ttl: number): number => {
  if (anthropic && ttl >= HOUR_MS) return rate.input * ANTHROPIC_HOUR_WRITE
  return rate.cacheWrite > 0 ? rate.cacheWrite : rate.input
}

/** Whether the catalog prices the model at all: a free or unlisted one has no bill. */
const priced = (rate: Rate) => rate.input > 0 || rate.output > 0

/** What compacting a prompt of `prompt` tokens on a cache of `ttl` ms costs and avoids; none for an unpriced model. */
export const billOf = (price: Price | undefined, prompt: number, ttl: number): Option.Option<Bill> => {
  if (price === undefined) return Option.none()
  const large = rateFor(price.rates, prompt)
  const small = rateFor(price.rates, SUMMARY_PROMPT)
  if (large === undefined || small === undefined || !priced(large)) return Option.none()
  const write = writeRate(large, price.anthropic, ttl)
  const fixed = SUMMARY_OUTPUT * large.output + SUMMARY_PROMPT * writeRate(small, price.anthropic, ttl)
  const saved = write - large.cacheRead
  return Option.some({
    avoided: (prompt * write) / MILLION,
    cost: (prompt * large.cacheRead + fixed) / MILLION,
    breakEven: saved > 0 ? Option.some(Math.ceil(fixed / saved)) : Option.none(),
  })
}

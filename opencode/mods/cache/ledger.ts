// A session's misses judged by its models' terms (cache lifetime and prices),
// the rows a turn shows, and a session family's sidebar total.
import { scan, resolve, type Miss, type Span, type Timeline } from "./miss.ts"
import { missCostUsd, rateFor, writeRate, type Rate } from "./price.ts"
import { missText, showsRow } from "./line.ts"
import { agentLifetimeMs, type CacheFamily, type ModelLifetime } from "./ttl.ts"

/** What the catalog says of one model: its cache family and lifetime, and its prices. */
export interface ModelTerms extends ModelLifetime {
  readonly family?: CacheFamily
  readonly rates: ReadonlyArray<Rate>
}

/** A miss, what it cost, and the row it draws if it is large enough. */
export interface Judged {
  readonly miss: Miss
  readonly costUsd: number
  /** The transcript row's text; undefined under the row's threshold. */
  readonly row?: string
}

/**
 * A session's misses, each judged by the terms of the model its step ran on
 * (`terms` answers by `providerID/modelID`; a model it does not know has no
 * lifetime and no price, so only a model switch counts and costs nothing)
 * and the cache lifetime the previous request's agent asked for (`agentTtl`
 * answers an agent's own `cacheTTL` by its id: a 5-minute role idle for 6
 * minutes expired, though its provider keeps an hour).
 */
export const judge = (
  timeline: Timeline,
  waits: ReadonlyArray<Span>,
  terms: (model: string) => ModelTerms | undefined,
  agentTtl: (agent: string) => string | undefined = () => undefined,
): ReadonlyArray<Judged> =>
  scan(timeline, waits).flatMap((scanned) => {
    const model = terms(scanned.model)
    const lifetime = agentLifetimeMs(model, scanned.agent === undefined ? undefined : agentTtl(scanned.agent))
    const miss = resolve(scanned, lifetime)
    if (miss === undefined) return []
    const rate = rateFor(model?.rates ?? [], miss.usage.promptTokens)
    const costUsd =
      rate === undefined
        ? 0
        : missCostUsd({ missedTokens: miss.missedTokens, cacheWriteTokens: miss.usage.cacheWriteTokens }, rate, writeRate(rate, model?.family, lifetime))
    return [showsRow(miss, costUsd) ? { miss, costUsd, row: missText(miss, costUsd) } : { miss, costUsd }]
  })

/**
 * The rows of the turn `messageID` closes: the misses of its steps, from the
 * step after the previous closing step through this one. The host draws a
 * turn's footer under its closing step, so the rows sit at the end of the
 * turn that paid for them. Nothing when `messageID` is no step of the timeline.
 */
export const turnRows = (timeline: Timeline, judged: ReadonlyArray<Judged>, messageID: string): ReadonlyArray<string> => {
  const steps = timeline.flatMap((entry) => (entry.type === "step" ? [entry] : []))
  const end = steps.findIndex((step) => step.id === messageID)
  if (end === -1) return []
  const start = steps.findLastIndex((step, index) => index < end && step.closes) + 1
  const turn = new Set(steps.slice(start, end + 1).map((step) => step.id))
  return judged.flatMap((item) => (item.row !== undefined && turn.has(item.miss.stepID) ? [item.row] : []))
}

/** What every judged miss of a family cost. */
export const missedUsd = (sessions: ReadonlyArray<ReadonlyArray<Judged>>): number =>
  sessions.reduce((total, judged) => total + judged.reduce((sum, item) => sum + item.costUsd, 0), 0)

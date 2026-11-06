// A session's misses judged by its models' terms (cache lifetime and prices),
// the rows a turn shows, and a session family's sidebar total.
import { scan, resolve, type Cause, type Miss, type Span, type Timeline } from "./miss.ts"
import { missCostUsd, rateFor, writeRate, type Rate } from "./price.ts"
import { missText, shortCause, showsRow } from "./line.ts"
import type { StepCause } from "./request-log.ts"
import { agentLifetimeMs, type CacheFamily, type ModelLifetime } from "./ttl.ts"

/**
 * A changed prefix as the server judged the step, which saw both requests:
 * the login its request went out on when the pool's record did not reach the
 * TUI, an unchanged prefix the cache lost anyway, or the segment that changed
 * first. Any other cause stands as the TUI's fold named it.
 */
export const refine = (cause: Cause, server: StepCause | undefined): Cause => {
  if (cause._tag !== "PrefixChanged" || server === undefined) return cause
  if (server.cause === "login") return { _tag: "LoginMoved" }
  if (server.cause === "unchanged") return { _tag: "Lost" }
  if (server.cause === "prefix" && server.change !== undefined)
    return { _tag: "PrefixChanged", change: { segment: server.change.segment, offsetTokens: server.change.offsetTokens } }
  return cause
}

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
 * minutes expired, though its provider keeps an hour). `server` answers how
 * the cache mod's server judged a step, by its assistant message: a changed
 * prefix is refined by it (`refine`).
 */
export const judge = (
  timeline: Timeline,
  waits: ReadonlyArray<Span>,
  terms: (model: string) => ModelTerms | undefined,
  agentTtl: (agent: string) => string | undefined = () => undefined,
  server: (stepID: string) => StepCause | undefined = () => undefined,
): ReadonlyArray<Judged> =>
  scan(timeline, waits).flatMap((scanned) => {
    const model = terms(scanned.model)
    const lifetime = agentLifetimeMs(model, scanned.agent === undefined ? undefined : agentTtl(scanned.agent))
    const resolved = resolve(scanned, lifetime)
    if (resolved === undefined) return []
    const miss: Miss = { ...resolved, cause: refine(resolved.cause, server(resolved.stepID)) }
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

/**
 * The cause, in the sidebar's few words (`shortCause`), that cost a family
 * the most; undefined when no miss cost anything.
 */
export const costliestCause = (sessions: ReadonlyArray<ReadonlyArray<Judged>>): string | undefined => {
  const costs = new Map<string, number>()
  for (const judged of sessions)
    for (const item of judged) {
      const name = shortCause(item.miss.cause)
      costs.set(name, (costs.get(name) ?? 0) + item.costUsd)
    }
  let best: readonly [string, number] | undefined
  for (const entry of costs) if (entry[1] > 0 && (best === undefined || entry[1] > best[1])) best = entry
  return best?.[0]
}

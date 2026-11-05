// Prompt-cache misses: a session's requests (steps) folded into the prefixes a
// step was billed for again although the previous request had cached them,
// each with its cause over the cache lifetime. A port of gent's
// `@gent/cache` fold (apps/tui/src/extensions/cache.client.tsx) over
// OpenCode's session messages instead of gent's event log.

/** A miss at or under this is cache breakpoint granularity, not a lost prefix. */
export const NOISE_FLOOR_TOKENS = 1024

/** A step's prompt and how much of it the cache served or stored. */
export interface Usage {
  /** Every prompt token: uncached input, cache reads and cache writes. */
  readonly promptTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** A stretch of time between two requests, named by what took it. */
export interface Span {
  readonly name: string
  /** When it started. */
  readonly at: number
  readonly ms: number
}

/** What opened a step's turn: a prompt, a background subagent's report, or other context. */
export interface Opener {
  readonly id: string
  readonly kind: "prompt" | "subagent" | "other"
}

/** One model request of a session: an assistant message. */
export interface Step {
  readonly type: "step"
  readonly id: string
  /** `providerID/modelID`. */
  readonly model: string
  /** When the request went out; the provider refreshes its cache then. */
  readonly startedAt: number
  /** When the response ended (`time.streamed`), before its tool calls ran. */
  readonly endedAt: number
  /** Undefined for a step that reported none (interrupted): it refreshed the cache all the same. */
  readonly usage?: Usage
  /** The tool calls this step asked for, from when each ran to when it settled. */
  readonly tools: ReadonlyArray<Span>
  readonly opener: Opener
  /** The step closed its turn: the host draws the turn's footer under it. */
  readonly closes: boolean
}

/** A compaction rewrote the context: the next prompt is new content, not a re-bill. */
export interface Compaction {
  readonly type: "compaction"
}

/** A session's steps and compactions, oldest first. */
export type Timeline = ReadonlyArray<Step | Compaction>

/** Why a prefix the previous request cached was billed again. */
export type Cause =
  /** The step ran on another model; its cache holds nothing of this prefix. */
  | { readonly _tag: "ModelSwitch" }
  /** Same model inside the lifetime, on a provider that writes its cache: the prefix itself changed (a moved cache marker, a changed system prompt or tool list). */
  | { readonly _tag: "PrefixChanged" }
  /** The previous response itself took most of the lifetime. */
  | { readonly _tag: "Response"; readonly ms: number }
  /** The cache expired while one tool call ran between two steps of a turn. */
  | { readonly _tag: "Tool"; readonly toolName: string; readonly ms: number }
  /** The cache expired while the turn waited for a permission to be answered. */
  | { readonly _tag: "Approval"; readonly ms: number }
  /** The cache expired between two steps of a turn with nothing to account for it. */
  | { readonly _tag: "Paused"; readonly ms: number }
  /** A background subagent's report opened this turn after the cache expired. */
  | { readonly _tag: "Child"; readonly ms: number }
  /** Any other new turn after the cache expired. */
  | { readonly _tag: "Idle"; readonly ms: number }

/** A lost prefix as the fold sees it, before the model's cache lifetime says why. */
export interface Scanned {
  /** The step that paid for it. */
  readonly stepID: string
  readonly startedAt: number
  readonly model: string
  /** Prefix tokens the previous request had cached that this one did not read. */
  readonly missedTokens: number
  readonly usage: Usage
  /** How long after the previous request started this one started: the lifetime runs from there. */
  readonly sinceRefreshMs: number
  readonly modelSwitch: boolean
  /** The model reported cache writes before: it holds a written prefix for the lifetime. */
  readonly explicitCache: boolean
  /** What took the time since the previous request started, if it outlived the lifetime. */
  readonly lapse: Cause
}

/** A miss with its cause. */
export interface Miss extends Omit<Scanned, "sinceRefreshMs" | "modelSwitch" | "explicitCache" | "lapse"> {
  readonly cause: Cause
}

const longest = (spans: ReadonlyArray<Span>): Span | undefined =>
  spans.reduce<Span | undefined>((best, span) => (best !== undefined && best.ms >= span.ms ? best : span), undefined)

/** A span covers the gap when it took at least half of it. */
const covers = (span: Span | undefined, gapMs: number): Span | undefined =>
  span !== undefined && span.ms * 2 >= gapMs ? span : undefined

/**
 * Why a prefix outlived its lifetime: what took the time between the previous
 * request's start and this one's. The previous response, if it took half the
 * gap; inside one turn, the longest approval wait, else the longest of the
 * previous step's tool calls, that took half the gap, else a pause; across
 * turns, a subagent's report or idle time.
 */
const expiredCause = (previous: Step, step: Step, gapMs: number, waits: ReadonlyArray<Span>): Cause => {
  const response = covers({ name: "response", at: previous.startedAt, ms: Math.max(0, previous.endedAt - previous.startedAt) }, gapMs)
  if (response !== undefined) return { _tag: "Response", ms: response.ms }
  if (step.opener.id === previous.opener.id) {
    const between = waits.filter((wait) => wait.at >= previous.startedAt && wait.at < step.startedAt)
    const wait = covers(longest(between), gapMs)
    if (wait !== undefined) return { _tag: "Approval", ms: wait.ms }
    const tool = covers(longest(previous.tools), gapMs)
    if (tool !== undefined) return { _tag: "Tool", toolName: tool.name, ms: tool.ms }
    return { _tag: "Paused", ms: gapMs }
  }
  return step.opener.kind === "subagent" ? { _tag: "Child", ms: gapMs } : { _tag: "Idle", ms: gapMs }
}

/** The last request that reported usage: everything in its prompt should read back. */
interface Cached {
  readonly promptTokens: number
  readonly model: string
  /** Some request since the last compaction reported cache activity. */
  readonly reportedCache: boolean
}

/**
 * Fold a session's timeline into its lost prefixes. A step's miss is the part
 * of the smaller of its prompt and the previous reporting step's prompt the
 * cache did not serve, above the noise floor. Nothing counts on a session
 * that never reported cache activity (a provider that reports none), or
 * across a compaction. The lifetime runs from the start of the last request
 * that went out, with usage or without. `waits` are the approval waits the
 * TUI saw, by when each was asked.
 */
export const scan = (timeline: Timeline, waits: ReadonlyArray<Span> = []): ReadonlyArray<Scanned> => {
  let previous: Cached | undefined
  let refreshed: Step | undefined
  const writers = new Set<string>()
  const found: Array<Scanned> = []
  for (const entry of timeline) {
    if (entry.type === "compaction") {
      previous = undefined
      continue
    }
    const step = entry
    const usage = step.usage
    const prior = previous
    const refresh = refreshed
    refreshed = step
    if (usage === undefined || usage.promptTokens <= 0) continue
    const reported = usage.cacheReadTokens + usage.cacheWriteTokens > 0
    if (usage.cacheWriteTokens > 0) writers.add(step.model)
    previous = { promptTokens: usage.promptTokens, model: step.model, reportedCache: reported || (prior?.reportedCache ?? false) }
    if (prior === undefined || refresh === undefined || (!reported && !prior.reportedCache)) continue
    const missedTokens = Math.min(prior.promptTokens, usage.promptTokens) - usage.cacheReadTokens
    if (missedTokens <= NOISE_FLOOR_TOKENS) continue
    const sinceRefreshMs = Math.max(0, step.startedAt - refresh.startedAt)
    found.push({
      stepID: step.id,
      startedAt: step.startedAt,
      model: step.model,
      missedTokens,
      usage,
      sinceRefreshMs,
      modelSwitch: step.model !== prior.model,
      explicitCache: writers.has(step.model),
      lapse: expiredCause(refresh, step, sinceRefreshMs, waits),
    })
  }
  return found
}

/**
 * The miss and its cause by the model's cache lifetime. A model switch always
 * counts. Time past the lifetime since the previous request started is the
 * lapse's doing. Inside it only an explicit cache's miss counts, as a changed
 * prefix: an implicit cache (OpenAI) reads only when the request reaches a
 * server that holds the prefix, so a miss there is no evidence. With no
 * lifetime only a model switch counts.
 */
export const resolve = (scanned: Scanned, lifetimeMs: number | undefined): Miss | undefined => {
  const { sinceRefreshMs, modelSwitch, explicitCache, lapse, ...miss } = scanned
  if (modelSwitch) return { ...miss, cause: { _tag: "ModelSwitch" } }
  if (lifetimeMs === undefined) return undefined
  if (sinceRefreshMs > lifetimeMs) return { ...miss, cause: lapse }
  return explicitCache ? { ...miss, cause: { _tag: "PrefixChanged" } } : undefined
}

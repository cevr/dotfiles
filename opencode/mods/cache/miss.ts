// Prompt-cache misses: a session's requests (steps) folded into the prefixes a
// step was billed for again although the previous request had cached them,
// each with its cause over the cache lifetime, folded over OpenCode's
// session messages.

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
  /** The agent that ran it: an agent may keep its own cache lifetime. */
  readonly agent?: string
  /** The pool's login (credential id) its request went out on, when the pool recorded it. */
  readonly login?: string
  /** The compaction's own summary request, not a step of the conversation. */
  readonly compaction?: true
}

/**
 * A compaction rewrote the context: from here the conversation's prefix is the
 * summary, so the next step writes it to the cache again. The summary request
 * itself, when it reported usage, comes before it as a step marked `compaction`.
 */
export interface Compaction {
  readonly type: "compaction"
}

/** A session's steps and compactions, oldest first. */
export type Timeline = ReadonlyArray<Step | Compaction>

/** The first segment of a request's prompt that differs from the request before it (fingerprint.ts). */
export interface PrefixChange {
  /** `system[1] ¶4`, `tool shell`, `messages[12] user part 0 (text)`, `end of prompt`. */
  readonly segment: string
  /** About how many prompt tokens come before it. */
  readonly offsetTokens: number
}

/** Why a prefix the previous request cached was billed again. */
export type Cause =
  /** The step ran on another model; its cache holds nothing of this prefix. */
  | { readonly _tag: "ModelSwitch" }
  /**
   * Same model inside the lifetime, on a provider that writes its cache: the
   * prefix itself changed (a changed system prompt, tool list or earlier
   * message). `change` names the first segment that changed, when the cache
   * mod's server compared the two requests (request-log.ts).
   */
  | { readonly _tag: "PrefixChanged"; readonly change?: PrefixChange }
  /** Inside the lifetime, on one login, the server saw the prefix unchanged and the cache still did not read it. */
  | { readonly _tag: "Lost" }
  /**
   * Inside the lifetime, around a compaction: `request` when the compaction's
   * own summary request missed the cached conversation; else the step after
   * it, whose prefix is the new summary.
   */
  | { readonly _tag: "Compaction"; readonly request: boolean }
  /** Inside the lifetime, the pool sent the step on another login than the cached one: a cache belongs to one login. */
  | { readonly _tag: "LoginMoved" }
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
  /** The agent of the previous request: its cache lifetime is the one that ran. */
  readonly agent?: string
  /** The step is a compaction's summary request, or the first to report after a compaction. */
  readonly compaction?: "request" | "after"
  /** The step went out on another pool login than the request that cached the prefix. */
  readonly loginMoved: boolean
  /** What took the time since the previous request started, if it outlived the lifetime. */
  readonly lapse: Cause
}

/** A miss with its cause. */
export interface Miss extends Omit<Scanned, "sinceRefreshMs" | "modelSwitch" | "explicitCache" | "lapse" | "agent" | "compaction" | "loginMoved"> {
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
  readonly login?: string
  /** Some request since the last compaction reported cache activity. */
  readonly reportedCache: boolean
}

/**
 * Fold a session's timeline into its lost prefixes. A step's miss is the part
 * of the smaller of its prompt and the previous reporting step's prompt the
 * cache did not serve, above the noise floor. Nothing counts on a session
 * that never reported cache activity (a provider that reports none). The
 * lifetime runs from the start of the last request that went out, with usage
 * or without. A compaction's summary request is a request like a step; the
 * first step to report after a compaction is marked, as its prefix is the new
 * summary. `waits` are the approval waits the TUI saw, by when each was asked.
 */
export const scan = (timeline: Timeline, waits: ReadonlyArray<Span> = []): ReadonlyArray<Scanned> => {
  let previous: Cached | undefined
  let refreshed: Step | undefined
  let compacted = false
  const writers = new Set<string>()
  const found: Array<Scanned> = []
  for (const entry of timeline) {
    if (entry.type === "compaction") {
      compacted = true
      continue
    }
    const step = entry
    const usage = step.usage
    const prior = previous
    const refresh = refreshed
    refreshed = step
    if (usage === undefined || usage.promptTokens <= 0) continue
    const compaction = step.compaction === true ? "request" : compacted ? "after" : undefined
    if (step.compaction !== true) compacted = false
    const reported = usage.cacheReadTokens + usage.cacheWriteTokens > 0
    if (usage.cacheWriteTokens > 0) writers.add(step.model)
    previous = {
      promptTokens: usage.promptTokens,
      model: step.model,
      ...(step.login === undefined ? {} : { login: step.login }),
      reportedCache: reported || (prior?.reportedCache ?? false),
    }
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
      ...(refresh.agent === undefined ? {} : { agent: refresh.agent }),
      ...(compaction === undefined ? {} : { compaction }),
      loginMoved: step.login !== undefined && prior.login !== undefined && step.login !== prior.login,
    })
  }
  return found
}

/**
 * The miss and its cause by the cache lifetime the previous request asked for
 * (its agent's, else its model's: ledger.ts). A model switch always counts.
 * Time past the lifetime since the previous request started is the lapse's
 * doing. Inside it only an explicit cache's miss counts: an implicit cache
 * (OpenAI) reads only when the request reaches a server that holds the
 * prefix, so a miss there is no evidence. Such a miss is the pool's move to
 * another login, else the compaction around it, else a changed prefix. With
 * no lifetime only a model switch counts.
 */
export const resolve = (scanned: Scanned, lifetimeMs: number | undefined): Miss | undefined => {
  const { sinceRefreshMs, modelSwitch, explicitCache, lapse, agent: _agent, compaction, loginMoved, ...miss } = scanned
  if (modelSwitch) return { ...miss, cause: { _tag: "ModelSwitch" } }
  if (lifetimeMs === undefined) return undefined
  if (sinceRefreshMs > lifetimeMs) return { ...miss, cause: lapse }
  if (!explicitCache) return undefined
  if (loginMoved) return { ...miss, cause: { _tag: "LoginMoved" } }
  if (compaction !== undefined) return { ...miss, cause: { _tag: "Compaction", request: compaction === "request" } }
  return { ...miss, cause: { _tag: "PrefixChanged" } }
}

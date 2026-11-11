// How much of its model's context window a session's last turn used, from the
// session's messages as the host keeps them: the newest assistant step with
// usage after the last completed compaction and before the revert point, its
// input, output, reasoning and cache tokens against the window automatic
// compaction plans for (`effectiveWindow`): the model's, capped by the step's
// agent's compaction window when it has one, so a 1M model whose agent
// compacts at 400k reads 207k as 52%, not 21%. Beside it, the latest turn's
// cache share, by the cache mod's measure.
import { cacheShare } from "@dotfiles/opencode-cache/line"
import type { Usage } from "./chrome.ts"
import type { Tokens } from "./session.ts"

/** The parts of a message the count reads. */
export type Metered = {
  readonly id: string
  readonly type: string
  readonly status?: string
  readonly tokens?: Tokens
  readonly model?: { readonly providerID: string; readonly id: string }
  /** The agent that ran the step, by id. */
  readonly agent?: string
}

/** A model's limits, as the host's catalog gives them. */
export type Limit = { readonly context: number; readonly input?: number }

/**
 * The window automatic compaction plans for, as the fork's compaction counts
 * it (core session/compaction.ts `autoLimit` and `inputWindow`): the largest
 * prompt the model takes (its input limit within its context window, either
 * alone when the other is unknown), narrowed to the agent's
 * `request.settings.compactionWindow` (a positive integer of tokens; anything
 * else is ignored), never raised by it. Undefined while neither is known.
 */
export function effectiveWindow(limit: Limit | undefined, compactionWindow: unknown): number | undefined {
  const model = limit ? (limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context) : 0
  const cap = typeof compactionWindow === "number" && Number.isInteger(compactionWindow) && compactionWindow > 0 ? compactionWindow : undefined
  if (cap === undefined) return model > 0 ? model : undefined
  return model > 0 && model <= cap ? model : cap
}

/** The index of the newest assistant step with usage, after the last completed compaction and before `boundary` (a revert point); -1 for none. */
const lastMetered = (messages: ReadonlyArray<Metered>, boundary?: string) => {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return -1
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compaction = messages.findLastIndex((message, index) => message.type === "compaction" && message.status === "completed" && index < end)
  return messages.findLastIndex((message, index) => message.type === "assistant" && message.tokens !== undefined && index > compaction && index < end)
}

/**
 * The cache share of the turn that step `last` ends (line.ts `cacheShare`, the
 * sidebar's measure): the run of assistant steps up to it, back to the
 * message before them (the prompt, a notice, a compaction), their prompt
 * tokens against the part the cache read. The latest turn rather than the
 * session's total, which the sidebar shows for the family: a break or an
 * expiry shows in it at once, where hundreds of earlier hits would bury it.
 */
const turnCache = (messages: ReadonlyArray<Metered>, last: number) => {
  let first = last
  while (first > 0 && messages[first - 1]!.type === "assistant") first--
  const hits = { promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const message of messages.slice(first, last + 1)) {
    const t = message.tokens
    if (!t) continue
    hits.promptTokens += t.input + t.cache.read + t.cache.write
    hits.cacheReadTokens += t.cache.read
    hits.cacheWriteTokens += t.cache.write
  }
  return cacheShare(hits)
}

/**
 * The session's context usage: undefined until a step reports tokens, and
 * without `percent` while `window` does not know the step's model. `window`
 * gets the step's model and agent (`effectiveWindow` for the host's). `cache`
 * is the latest turn's cache share (`turnCache`), absent without cache activity.
 */
export function contextUsage(
  messages: ReadonlyArray<Metered>,
  window: (model: { readonly providerID: string; readonly id: string }, agent: string | undefined) => number | undefined,
  boundary?: string,
): Usage | undefined {
  const at = lastMetered(messages, boundary)
  const last = messages[at]
  if (!last?.tokens) return undefined
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return undefined
  const limit = last.model ? window(last.model, last.agent) : undefined
  const cache = turnCache(messages, at)
  return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : undefined, ...(cache === undefined ? {} : { cache }) }
}

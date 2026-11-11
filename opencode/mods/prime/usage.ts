// How much of its model's context window a session's last turn used, from the
// session's messages as the host keeps them: the newest assistant step with
// usage after the last completed compaction and before the revert point, its
// input, output, reasoning and cache tokens against the window automatic
// compaction plans for (`effectiveWindow`): the model's, capped by the step's
// agent's compaction window when it has one, so a 1M model whose agent
// compacts at 400k reads 207k as 52%, not 21%.
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

/** The newest assistant step with usage, after the last completed compaction and before `boundary` (a revert point). */
const lastMetered = (messages: ReadonlyArray<Metered>, boundary?: string) => {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compaction = messages.findLastIndex((message, index) => message.type === "compaction" && message.status === "completed" && index < end)
  return messages.findLast((message, index) => message.type === "assistant" && message.tokens !== undefined && index > compaction && index < end)
}

/**
 * The session's context usage: undefined until a step reports tokens, and
 * without `percent` while `window` does not know the step's model. `window`
 * gets the step's model and agent (`effectiveWindow` for the host's).
 */
export function contextUsage(
  messages: ReadonlyArray<Metered>,
  window: (model: { readonly providerID: string; readonly id: string }, agent: string | undefined) => number | undefined,
  boundary?: string,
): Usage | undefined {
  const last = lastMetered(messages, boundary)
  if (!last?.tokens) return undefined
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return undefined
  const limit = last.model ? window(last.model, last.agent) : undefined
  return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : undefined }
}

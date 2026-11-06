// How much of its model's context window a session's last turn used, from the
// session's messages as the host keeps them: the newest assistant step with
// usage after the last completed compaction and before the revert point, its
// input, output, reasoning and cache tokens against its model's window. As the
// host's own prompt footer counts it.
import type { Usage } from "./chrome.ts"
import type { Tokens } from "./session.ts"

/** The parts of a message the count reads. */
export type Metered = {
  readonly id: string
  readonly type: string
  readonly status?: string
  readonly tokens?: Tokens
  readonly model?: { readonly providerID: string; readonly id: string }
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
 * without `percent` while `window` does not know the step's model.
 */
export function contextUsage(
  messages: ReadonlyArray<Metered>,
  window: (model: { readonly providerID: string; readonly id: string }) => number | undefined,
  boundary?: string,
): Usage | undefined {
  const last = lastMetered(messages, boundary)
  if (!last?.tokens) return undefined
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return undefined
  const limit = last.model ? window(last.model) : undefined
  return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : undefined }
}

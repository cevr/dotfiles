// A compaction as the transcript reads it, without rendering. Below All it
// is one line (`◇ Compacted automatically · 171k → 6k tokens · 12s`); at All
// it is the host's own block: a rule with its label and usage, then the
// summary or the error.
import { span } from "./call.ts"
import { compactTokens } from "./chrome.ts"
import type { CompactionMessage, Message, Tokens } from "./session.ts"

/** The tokens of the compaction request's prompt: the context it compacted. */
function prompt(tokens: Tokens) {
  return tokens.input + tokens.cache.read + tokens.cache.write
}

/** Whether a failed compaction was cut short (the reader's interrupt), not failed. */
function cancelled(message: CompactionMessage) {
  return message.status === "failed" && message.error.type === "aborted"
}

/**
 * How long a compaction took. The host keeps no end time on a compaction, so
 * this reads the start of the message the same run writes next: the step the
 * compaction resumes, or the run's idle marker. Unknown while it runs, or
 * when something else follows it.
 */
export function compactionTime(message: CompactionMessage, next: Message | undefined): number | undefined {
  if (message.status === "running" || !next) return undefined
  if (next.type !== "assistant" && next.type !== "idle") return undefined
  return Math.max(0, next.time.created - message.time.created)
}

/** The one line a compaction draws below All; a running one is the live spinner line, with today's words. */
export type CompactionLine = {
  readonly glyph: "spinner" | "◇"
  readonly tone: "muted" | "warning"
  readonly text: string
}

/**
 * The compaction's line below All. `automatically` covers reason `auto`
 * (idle compaction, the fork's window-triggered one); the token counts are
 * the compaction request's own: its prompt (the context it compacted) to
 * its output (the summary that replaces it).
 */
export function compactionLine(message: CompactionMessage, next: Message | undefined): CompactionLine {
  const auto = message.reason === "auto"
  if (message.status === "running")
    return { glyph: "spinner", tone: "muted", text: auto ? "Automatic compaction" : "Compaction" }
  if (message.status === "failed") {
    if (cancelled(message)) return { glyph: "◇", tone: "warning", text: "Compaction cancelled" }
    const reason = (message.error.message.split("\n")[0] ?? "").trim()
    return { glyph: "◇", tone: "warning", text: ["Compaction failed", reason].filter(Boolean).join(" · ") }
  }
  const tokens = message.tokens && prompt(message.tokens) > 0 ? message.tokens : undefined
  const time = compactionTime(message, next)
  return {
    glyph: "◇",
    tone: "muted",
    text: [
      auto ? "Compacted automatically" : "Compacted",
      tokens ? `${compactTokens(prompt(tokens))} → ${compactTokens(tokens.output)} tokens` : undefined,
      time === undefined ? undefined : span(time),
    ]
      .filter(Boolean)
      .join(" · "),
  }
}

/** The host's count: `171.0K`, `1.2M` (the fork's `Locale.number`). */
function count(value: number) {
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

/** The compaction block at All, as the host draws it today: its rule's words, then its body. */
export type CompactionBlock = {
  readonly running: boolean
  /** A failure the reader did not cause: `✗`, in the error tone. */
  readonly failed: boolean
  readonly label: string
  /** `cancelled`, then the request's usage (`171.0K in · 6.0K out`). */
  readonly details: ReadonlyArray<string>
  /** The summary, or a failure's error; empty for a cancel. */
  readonly body: string
}

export function compactionBlock(message: CompactionMessage): CompactionBlock {
  const cut = cancelled(message)
  const usage = (() => {
    if (message.status === "running" || !message.tokens) return undefined
    const input = prompt(message.tokens)
    const output = message.tokens.output + message.tokens.reasoning
    return input + output > 0 ? `${count(input)} in · ${count(output)} out` : undefined
  })()
  const label =
    message.status === "completed" && message.native?.messages
      ? "Provider compaction"
      : message.reason === "auto"
        ? "Automatic compaction"
        : "Compaction"
  return {
    running: message.status === "running",
    failed: message.status === "failed" && !cut,
    label,
    details: [cut ? "cancelled" : undefined, usage].filter((value): value is string => value !== undefined),
    body: (message.status === "failed" ? (cut ? "" : message.error.message) : message.summary).trim(),
  }
}

/** The compaction message `messageID` and the message after it, in transcript order. */
export function compactionAt(
  messages: ReadonlyArray<Message>,
  messageID: string,
): { readonly message: CompactionMessage; readonly next: Message | undefined } | undefined {
  const at = messages.findIndex((message) => message.id === messageID)
  const message = messages[at]
  if (message?.type !== "compaction") return undefined
  return { message, next: messages[at + 1] }
}

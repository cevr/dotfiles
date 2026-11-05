// The ask pinned over the transcript while the reader is scrolled up: the
// prompt the rows at the top of the view answer, as a sticky header, cut to
// one line. Plain functions over the host's message list and the rows the
// fork's session.transcript.overlay slot measures.
import { fit } from "@dotfiles/opencode-subagents/line"

/** The fields of a session message the pick reads. */
export type Message = { readonly id: string; readonly type: string; readonly text?: string }
/** A mounted message's first row, relative to the viewport's top row (negative: above it). */
export type MessageRow = { readonly messageID: string; readonly row: number }

/**
 * A prompt the reader wrote: a user message with text. Mail, steers from
 * other sessions, completion and compaction notices, shell runs and skill
 * loads are other message types (synthetic, system, compaction, shell, skill).
 */
export function isAsk(message: Message): boolean {
  return message.type === "user" && (message.text ?? "").trim() !== ""
}

/**
 * The prompt that governs the viewport's top row: the newest ask at or above
 * it, `messages` in transcript order. None while the view's top row is above
 * every mounted message (the transcript's start), and none while that ask's
 * own first row is the top row, where it shows itself.
 */
export function governingAsk(messages: ReadonlyArray<Message>, rows: ReadonlyArray<MessageRow>): Message | undefined {
  const top = rows.filter((row) => row.row <= 0).at(-1)
  if (!top) return undefined
  const index = messages.findIndex((message) => message.id === top.messageID)
  const ask = messages.slice(0, index + 1).findLast(isAsk)
  if (!ask) return undefined
  if (rows.find((row) => row.messageID === ask.id)?.row === 0) return undefined
  return ask
}

/** `text` on one line of at most `width` columns: whitespace runs collapse to a space, an ellipsis stands for the rest. */
export function oneLine(text: string, width: number): string {
  return fit(text.replace(/\s+/g, " ").trim(), width)
}

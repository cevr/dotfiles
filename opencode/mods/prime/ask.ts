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

/** A prompt as the side channel keeps it: its id, when it was written, and its text on one line, cut short. */
export type Prompt = { readonly id: string; readonly time: number; readonly text: string }

/**
 * A session's prompts read apart from its transcript (the side channel), newest first: the pages
 * the server listed (`message.list` of `type: "user"`), with the prompts the transcript received
 * since at the head. `next` is the cursor of the next older page, none once the session's start was
 * read; `read` turns true with the first page.
 */
export type AskIndex = {
  readonly prompts: ReadonlyArray<Prompt>
  readonly next: string | undefined
  readonly read: boolean
}

export const EMPTY_INDEX: AskIndex = { prompts: [], next: undefined, read: false }

/** Characters of a prompt the index keeps: more than the widest pin shows. */
export const PROMPT_LENGTH = 200

/** A user message as the index keeps it, or none when it has no words (a prompt of attachments only is no ask). */
export function promptOf(message: {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly time?: { readonly created: number }
}): Prompt | undefined {
  if (!isAsk(message)) return undefined
  const text = (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, PROMPT_LENGTH)
  return { id: message.id, time: message.time?.created ?? 0, text }
}

/** The index with a page of older prompts (newest first) after what it holds, and the cursor after that page. */
export function withPage(index: AskIndex, page: ReadonlyArray<Prompt>, next: string | undefined): AskIndex {
  const known = new Set(index.prompts.map((prompt) => prompt.id))
  return { prompts: [...index.prompts, ...page.filter((prompt) => !known.has(prompt.id))], next, read: true }
}

/**
 * The index with the transcript's loaded prompts newer than its head put at the head: the window
 * holds every prompt as it arrives, so the index learns new prompts without reading again, and
 * keeps them once a re-read window no longer holds them. A loaded prompt older than the head is one
 * a later page brings. Before the first page nothing is kept: that page holds them.
 */
export function withLoaded(index: AskIndex, loaded: ReadonlyArray<Message & { readonly time?: { readonly created: number } }>): AskIndex {
  if (!index.read) return index
  const head = index.prompts[0]
  const known = new Set(index.prompts.map((prompt) => prompt.id))
  const fresh = loaded
    .flatMap((message) => promptOf(message) ?? [])
    .filter((prompt) => !known.has(prompt.id) && (!head || prompt.time > head.time))
  if (fresh.length === 0) return index
  return { ...index, prompts: [...fresh.toReversed(), ...index.prompts] }
}

/** What the pin shows, and whether the index must read a page more to know it. */
export type Pin = { readonly ask: { readonly id: string; readonly text?: string } | undefined; readonly wants: boolean }

/**
 * The prompt pinned over the transcript: the loaded ask governing the top row (`governingAsk`);
 * when no loaded ask precedes the top message, the newest prompt of the index the window does not
 * hold. The window is the session's newest messages, so every prompt newer than its oldest message
 * is loaded and that prompt is the nearest one above the top. `wants` asks for the first page, or a
 * page more, when the index has no such prompt yet and the session's start is not read.
 */
export function pinnedAsk(loaded: ReadonlyArray<Message>, rows: ReadonlyArray<MessageRow>, index: AskIndex): Pin {
  const top = rows.filter((row) => row.row <= 0).at(-1)
  if (!top) return { ask: undefined, wants: false }
  const at = loaded.findIndex((message) => message.id === top.messageID)
  if (loaded.slice(0, at + 1).some(isAsk)) return { ask: governingAsk(loaded, rows), wants: false }
  const held = new Set(loaded.map((message) => message.id))
  const older = index.prompts.find((prompt) => !held.has(prompt.id))
  if (older) return { ask: older, wants: false }
  return { ask: undefined, wants: !index.read || index.next !== undefined }
}

/** `text` on one line of at most `width` columns: whitespace runs collapse to a space, an ellipsis stands for the rest. */
export function oneLine(text: string, width: number): string {
  return fit(text.replace(/\s+/g, " ").trim(), width)
}

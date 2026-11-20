// The ask pinned over the transcript while the reader is scrolled up: the
// prompt the rows at the top of the view answer, as a sticky header, cut to
// one line. Plain functions over the host's message list, the rows the
// fork's session.transcript.overlay slot measures, and the session's prompts
// read apart from the transcript (AskIndex, opencode/asks.ts reads it).
import { fit } from "@dotfiles/opencode-subagents/line"
import { Array as Arr, Option } from "effect"

/** The fields of a session message the pick reads. */
export type Message = { readonly id: string; readonly type: string; readonly text?: string }
/** A message with the time it was written, as the host and the server hold it. */
export type Written = Message & { readonly time?: { readonly created: number } }
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
  readonly next: Option.Option<string>
  readonly read: boolean
}

export const EMPTY_INDEX: AskIndex = { prompts: [], next: Option.none(), read: false }

/** Characters of a prompt the index keeps: more than the widest pin shows. */
export const PROMPT_LENGTH = 200

const textOf = (message: Message) => Option.getOrElse(Option.fromUndefinedOr(message.text), () => "")

/** A user message as the index keeps it; none when it has no words (a prompt of attachments only is no ask). */
export function promptOf(message: Written): Option.Option<Prompt> {
  return Option.map(Option.liftPredicate(message, isAsk), (ask) => ({
    id: ask.id,
    time: Option.match(Option.fromUndefinedOr(ask.time), { onNone: () => 0, onSome: (time) => time.created }),
    text: textOf(ask).replace(/\s+/g, " ").trim().slice(0, PROMPT_LENGTH),
  }))
}

/** The index with a page of older prompts (newest first) after what it holds, and the cursor after that page. */
export function withPage(index: AskIndex, page: ReadonlyArray<Prompt>, next: Option.Option<string>): AskIndex {
  const known = new Set(index.prompts.map((prompt) => prompt.id))
  return { prompts: [...index.prompts, ...page.filter((prompt) => !known.has(prompt.id))], next, read: true }
}

/**
 * The index with the transcript's loaded prompts newer than its head put at the head: the window
 * holds every prompt as it arrives, so the index learns new prompts without reading again, and
 * keeps them once a re-read window no longer holds them. A loaded prompt older than the head is one
 * a later page brings. Before the first page nothing is kept: that page holds them.
 */
export function withLoaded(index: AskIndex, loaded: ReadonlyArray<Written>): AskIndex {
  if (!index.read) return index
  const newer = (prompt: Prompt) =>
    Option.match(Arr.head(index.prompts), { onNone: () => true, onSome: (head) => prompt.time > head.time })
  const known = new Set(index.prompts.map((prompt) => prompt.id))
  const fresh = loaded.flatMap((message) => Option.toArray(promptOf(message))).filter((prompt) => !known.has(prompt.id) && newer(prompt))
  if (fresh.length === 0) return index
  return { ...index, prompts: [...fresh.toReversed(), ...index.prompts] }
}

/** A pinned prompt: its id and its text. */
export type Pinned = { readonly id: string; readonly text: string }
/** What the pin shows, and whether the index must read a page more to know it. */
export type Pin = { readonly ask: Option.Option<Pinned>; readonly wants: boolean }

/** No pin, and no read wanted. */
export const NO_PIN: Pin = { ask: Option.none(), wants: false }

/**
 * The prompt pinned over the transcript: the loaded ask governing the top row (`governingAsk`);
 * when no loaded ask precedes the top message, the newest prompt of the index the window does not
 * hold. The window is the session's newest messages, so every prompt newer than its oldest message
 * is loaded and that prompt is the nearest one above the top. `wants` asks for the first page, or a
 * page more, when the index has no such prompt yet and the session's start is not read.
 */
export function pinnedAsk(loaded: ReadonlyArray<Message>, rows: ReadonlyArray<MessageRow>, index: AskIndex): Pin {
  return Option.match(Arr.last(rows.filter((row) => row.row <= 0)), {
    onNone: () => NO_PIN,
    onSome: (top) => {
      const at = loaded.findIndex((message) => message.id === top.messageID)
      if (loaded.slice(0, at + 1).some(isAsk)) {
        const ask = Option.map(Option.fromUndefinedOr(governingAsk(loaded, rows)), (found) => ({ id: found.id, text: textOf(found) }))
        return { ask, wants: false }
      }
      const held = new Set(loaded.map((message) => message.id))
      const older = Arr.findFirst(index.prompts, (prompt) => !held.has(prompt.id))
      const wants = Option.isNone(older) && (!index.read || Option.isSome(index.next))
      return { ask: Option.map(older, (prompt) => ({ id: prompt.id, text: prompt.text })), wants }
    },
  })
}

/** `text` on one line of at most `width` columns: whitespace runs collapse to a space, an ellipsis stands for the rest. */
export function oneLine(text: string, width: number): string {
  return fit(text.replace(/\s+/g, " ").trim(), width)
}

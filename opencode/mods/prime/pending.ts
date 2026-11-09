// What the runner has not taken yet, without rendering: the prompts that wait
// in the session's inbox, the queued rows above the composer that show them
// until the runner takes them, and when the loader shows and what it times.
import { oneLine } from "./ask.ts"
import type { Message } from "./session.ts"

/**
 * One item of the session's inbox, as the host lists it (`data.session.pending`):
 * a prompt the reader sent (`user`), a program's message (`synthetic`), a
 * compaction asked for, or a move. `steer` goes in at the runner's next step,
 * `queue` once the turn and every steer are done.
 */
export type PendingItem = {
  readonly id: string
  readonly type: string
  readonly time: { readonly created: number }
  readonly delivery: "steer" | "queue"
  readonly payload?: unknown
}

/** A prompt the runner has not taken: its inbox id, its text and when it goes in. */
export type WaitingPrompt = { readonly id: string; readonly text: string; readonly delivery: "steer" | "queue" }

function textOf(payload: unknown) {
  if (typeof payload !== "object" || payload === null || !("text" in payload)) return ""
  return typeof payload.text === "string" ? payload.text : ""
}

/**
 * Whether the message is a prompt the runner has not taken: the transcript
 * leaves it out until it has, its row's gap too (the layout rule's
 * `messageID`, cmd/prime/tui.tsx), so it takes no space.
 */
export function isWaiting(pending: ReadonlyArray<PendingItem>, messageID: string) {
  return pending.some((item) => item.id === messageID && item.type === "user")
}

/**
 * The prompts the queued rows show, as one list, oldest first: the reader's
 * steers the runner has not taken and the prompts sent to the queue. The
 * list replaces the host's own queued box (`N queued · …`, the fork's
 * `session.composer.queued` slot), so no prompt shows twice.
 */
export function waitingPrompts(pending: ReadonlyArray<PendingItem>): ReadonlyArray<WaitingPrompt> {
  return pending
    .filter((item) => item.type === "user")
    .toSorted((a, b) => a.time.created - b.time.created)
    .map((item) => ({ id: item.id, text: textOf(item.payload), delivery: item.delivery }))
}

/** The lead of a queued row: a steer goes in at the runner's next step, a queued prompt once the turn ends. */
export function lead(delivery: WaitingPrompt["delivery"]) {
  return delivery === "steer" ? "◌ queued · " : "◌ after the turn · "
}

/**
 * A queued row in `width` cells, its text on one line, cut to fit:
 * `◌ queued · Also update the docs.` for a steer, `◌ after the turn · Then
 * bump the version.` for a prompt sent to the queue.
 */
export function queuedRow(prompt: WaitingPrompt, width: number) {
  const head = lead(prompt.delivery)
  return head + oneLine(prompt.text, Math.max(1, width - [...head].length))
}

/**
 * The escape plugin's Ctrl+Enter command (`SEND_COMMAND` in
 * mods/escape/send.ts): interrupt the turn and send what waits. The hint
 * reads its key by this id, so it shows only while that plugin binds one.
 */
export const SEND_COMMAND = "dotfiles.escape.send"

/** A key as the hint line writes it (`Ctrl+O`): each part capitalised, `return` as `Enter`. */
export function keyLabel(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => (part.toLowerCase() === "return" ? "Enter" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+")
}

/**
 * The hint above the composer for the send key, while a turn runs and a
 * prompt waits behind it: `Ctrl+Enter interrupt and send`. Empty otherwise,
 * or when no key is bound to the command.
 */
export function sendHint(input: { readonly shortcut: string | undefined; readonly running: boolean; readonly waiting: number }) {
  if (!input.shortcut || !input.running || input.waiting === 0) return ""
  return `${keyLabel(input.shortcut)} interrupt and send`
}

/** What a queued row's click offers, as the host's own pending rows do; `value` is the inbox move. */
export type PendingAction = {
  readonly title: string
  readonly value: "steer" | "queue" | "cancel"
  readonly description?: string
}

/**
 * A steer can move to the queue or go; a queued prompt can be sent now (a
 * steer, the host picker's Enter) or go.
 */
export function pendingActions(delivery: WaitingPrompt["delivery"]): ReadonlyArray<PendingAction> {
  const remove: PendingAction = { title: "Delete", value: "cancel" }
  return delivery === "steer"
    ? [{ title: "Move to queue", value: "queue", description: "after the turn, not at its next step" }, remove]
    : [{ title: "Send now", value: "steer", description: "at the turn's next step" }, remove]
}

/** Since when the `Executing` loader counts; undefined counts from when the loader saw the run. */
export type Loader = { readonly since: number | undefined }

/**
 * Whether the `Executing` loader shows, and since when it counts. While a
 * compaction of the current run (after its last idle marker) runs, none
 * shows: the compaction's own row carries the spinner and its time
 * (compaction.ts `compactionLine`), so the wait reads as one row. Otherwise
 * it counts from the run's first model step, which starts when the runner
 * takes the prompt (a prompt that waited behind a compaction counts from
 * then, not from when it was sent). Before that first step it counts from
 * the run's newest prompt the runner took, and with none from when the
 * loader saw the run (undefined); a waiting prompt never moves the clock.
 */
export function loader(messages: ReadonlyArray<Message>, pending: ReadonlyArray<PendingItem>): Loader | undefined {
  const idle = messages.findLastIndex((message) => message.type === "idle")
  const run = messages.slice(idle + 1)
  const compaction = run.findLast((message) => message.type === "compaction")
  if (compaction?.type === "compaction" && compaction.status === "running") return undefined
  const step = run.find((message) => message.type === "assistant")
  if (step) return { since: step.time.created }
  const taken = run.filter((message) => message.type === "user" && !isWaiting(pending, message.id))
  const prompt = taken.at(-1)
  return { since: prompt?.time.created }
}

// What the runner has not taken yet, without rendering: the prompts that wait
// in the session's inbox, the queued rows above the composer that show them
// until the runner takes them, and what the loader names and times.
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

/** A prompt the runner has not taken: its inbox id and its text. */
export type WaitingPrompt = { readonly id: string; readonly text: string }

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
 * The prompts the queued rows show, oldest first: the reader's steers the
 * runner has not taken. A `queue` prompt is the host's own queued dock's
 * (`N queued · …`, which opens its Queued prompts picker), so it is not
 * listed twice.
 */
export function waitingPrompts(pending: ReadonlyArray<PendingItem>): ReadonlyArray<WaitingPrompt> {
  return pending
    .filter((item) => item.type === "user" && item.delivery === "steer")
    .toSorted((a, b) => a.time.created - b.time.created)
    .map((item) => ({ id: item.id, text: textOf(item.payload) }))
}

/** The lead of a queued row. */
export const QUEUED = "◌ queued · "

/** A queued row in `width` cells: `◌ queued · Also update the docs.`, its text on one line, cut to fit. */
export function queuedRow(prompt: WaitingPrompt, width: number) {
  return QUEUED + oneLine(prompt.text, Math.max(1, width - [...QUEUED].length))
}

/** What the loader says, and since when it counts. */
export type Loader = { readonly label: "Compacting" | "Executing"; readonly since: number | undefined }

/**
 * What runs and since when. A compaction running in the current run (after
 * its last idle marker) is `Compacting`, from the compaction's start;
 * otherwise `Executing`, from the run's first model step, which starts when
 * the runner takes the prompt (a prompt that waited behind a compaction
 * counts from then, not from when it was sent). Before that first step it
 * counts from the run's newest prompt the runner took, and with none from
 * when the loader saw the run (undefined); a waiting prompt never moves the
 * clock.
 */
export function loader(messages: ReadonlyArray<Message>, pending: ReadonlyArray<PendingItem>): Loader {
  const idle = messages.findLastIndex((message) => message.type === "idle")
  const run = messages.slice(idle + 1)
  const compaction = run.findLast((message) => message.type === "compaction")
  if (compaction?.type === "compaction" && compaction.status === "running")
    return { label: "Compacting", since: compaction.time.created }
  const step = run.find((message) => message.type === "assistant")
  if (step) return { label: "Executing", since: step.time.created }
  const taken = run.filter((message) => message.type === "user" && !isWaiting(pending, message.id))
  const prompt = taken.at(-1)
  return { label: "Executing", since: prompt?.time.created }
}

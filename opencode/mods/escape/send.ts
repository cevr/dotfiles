// What one Ctrl+Enter does to the session on screen, decided without the host.
// On a busy session it interrupts the turn and sends what waits as the next
// turn: a draft in the composer goes to the session's queue first, then the
// turn stops and every prompt still waiting goes out, oldest first. With
// nothing to send it does nothing, so it never interrupts by itself. On an
// idle session it submits, as Enter does. A permission or question keeps the
// key, as does a subagent's view (which has no composer) and a screen with no
// editor focused. cmd/escape/setup.ts acts on the decision; the order it acts
// in is what keeps every prompt sent exactly once (see `plan`).
import type { View } from "./escape.ts"

/** The keymap command id of Ctrl+Enter, which a hint reads its shortcut by (`keymap.shortcuts`). */
export const SEND_COMMAND = "dotfiles.escape.send"

/** Ctrl+Enter, in the host's key syntax. A terminal tells it from Enter only with the kitty keyboard protocol on. */
export const SEND_KEY = "ctrl+return"

/**
 * The same, as a chord every terminal sends: the leader (Ctrl+X) then F. A
 * terminal without the kitty keyboard protocol (Terminal.app, tmux without
 * extended keys) sends Ctrl+Enter as a plain Enter, which steers.
 */
export const SEND_FALLBACK = "<leader>f"

/** A prompt the runner has not taken, as Ctrl+Enter reads the session's inbox. */
export interface Waiting {
  readonly id: string
  /** `steer` goes in at the runner's next step, `queue` once the turn ends. */
  readonly delivery: "steer" | "queue"
}

export type Send =
  /** Submit the composer, as Enter does: the session is idle. */
  | { readonly _tag: "Submit" }
  /**
   * Interrupt the turn and send what waits: the draft (when `draft`) and the
   * prompts in the inbox, as the next turn.
   */
  | { readonly _tag: "InterruptSend"; readonly sessionID: string; readonly draft: boolean }
  /** A busy session with nothing to send: the key does nothing (it does not interrupt alone). */
  | { readonly _tag: "Nothing" }
  /** Leave the key to the host. */
  | { readonly _tag: "Pass" }

const pass: Send = { _tag: "Pass" }

/** The decision for one Ctrl+Enter, given the session's prompts still waiting in its inbox. */
export const decideSend = (view: View | undefined, waiting: ReadonlyArray<Waiting>): Send => {
  if (view === undefined || view.blocked || view.subagent || view.composer === "none") return pass
  if (!view.busy) return { _tag: "Submit" }
  const draft = view.composer === "draft"
  if (!draft && waiting.length === 0) return { _tag: "Nothing" }
  return { _tag: "InterruptSend", sessionID: view.sessionID, draft }
}

/**
 * How the interrupt and the inbox moves are ordered, once the draft (if any)
 * is in the queue. A queued prompt is parked: the stopping turn never takes
 * one, so it cannot be swallowed by the turn the interrupt kills. With no
 * queued prompt, only steers wait: the interrupt resumes them itself (the
 * server's `resume`), as one next turn. With queued prompts, the interrupt
 * does not resume; once the server has taken it (the stopping turn takes no
 * new work), each queued prompt moves to the steers, oldest first, and each
 * move rings for the turn after it, which starts once the stopping turn
 * settles and takes every steer then waiting (one that lands later goes in
 * at that turn's next step). Nothing is sent twice: the only new prompt is
 * the draft, sent once by the host; the rest are moves of prompts already
 * in the inbox, and a move of one the session already took is refused.
 */
export const plan = (waiting: ReadonlyArray<Waiting>) => {
  const promote = waiting.filter((item) => item.delivery === "queue").map((item) => item.id)
  return { resume: promote.length === 0, promote }
}

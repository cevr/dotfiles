// What one Escape does to the session on screen, decided without the host.
// One Escape on a busy session stops its run. Within the grace after the
// session's newest prompt was sent, Escape on an empty composer takes that
// prompt back: the run stops, the session reverts to before it and its text
// returns to the composer. After the grace, or with a draft in the composer
// or no editor focused, Escape interrupts and the prompt stays. A prompt still
// waiting in the session's inbox (queued, or a steer not yet delivered) comes
// back to the composer whatever the grace, and the run it waited behind stops
// too; nothing in the inbox is dropped. In a subagent's view, Escape
// interrupts that subagent. opencode/view.ts reads the view from the TUI's
// data; cmd/escape/setup.ts acts on the decision and says when the session
// did not stop.

/** The default grace, in milliseconds (the plugin's `grace` option; 0 always interrupts). */
export const DEFAULT_GRACE_MS = 5_000

/** How long a take-back is assumed to be settling: a second Escape for the same prompt meanwhile does not take it back again. */
export const SETTLE_MS = 10_000

/** How long after an Escape the session may still run before the TUI says the server has not stopped it. */
export const STOP_MS = 5_000

/**
 * Whether the turn a press asked to stop has not stopped, STOP_MS after it:
 * the server never said the turn ended (`ended`) and the session still runs.
 * A turn that ended counts as stopped though the session runs again: the
 * interrupt's resume and Ctrl+Enter's sent prompts start the next turn at once.
 */
export const hung = (turn: { readonly ended: boolean; readonly running: boolean }) => !turn.ended && turn.running

/** The session's newest user prompt with text, as Escape reads it. */
export interface Prompt {
  readonly id: string
  /** When it was sent, in epoch milliseconds. */
  readonly created: number
  /** It still waits in the session's inbox (queued, or a steer the model has not read). */
  readonly pending: boolean
  /** The run after it called a shell, whose effects a revert does not undo. */
  readonly ranShell: boolean
}

/** The session on screen, as Escape reads it. */
export interface View {
  readonly sessionID: string
  /** A subagent's view: the host shows its Subagents picker in place of the composer. */
  readonly subagent: boolean
  /** The session's run is going (`data.session.status` is "running"). */
  readonly busy: boolean
  /** A permission request or a question waits for the user; Escape is theirs. */
  readonly blocked: boolean
  readonly latest: Prompt | undefined
  /**
   * What the focused text editor holds: `"empty"`, `"draft"` (text or an
   * attachment), or `"none"` when no editor has focus.
   */
  readonly composer: "empty" | "draft" | "none"
}

/** A take-back this TUI started and has not seen settle. */
export interface Taking {
  readonly messageID: string
  readonly at: number
}

export type Action =
  /**
   * Take the prompt back into the composer (the host's `session.undo`): a sent
   * prompt's run stops and the session reverts to before it; a pending one
   * leaves the inbox, and with `stop` the run it waited behind is
   * interrupted too (without resuming the inbox, so the prompt being taken
   * back is not delivered first).
   */
  | {
      readonly _tag: "TakeBack"
      readonly sessionID: string
      readonly messageID: string
      readonly pending: boolean
      readonly ranShell: boolean
      readonly stop: boolean
    }
  /** Stop the run; the prompt and its partial answer stay. */
  | { readonly _tag: "Interrupt"; readonly sessionID: string }
  /** A take-back of this prompt is still settling: nothing new to do, which the TUI says. */
  | { readonly _tag: "Settling"; readonly sessionID: string }
  /** Leave the key to the host. */
  | { readonly _tag: "Pass" }

const pass: Action = { _tag: "Pass" }

/** The decision for one Escape at `now`, given the grace and the take-back still settling, if any. */
export const decide = (view: View | undefined, input: { readonly now: number; readonly grace: number; readonly taking?: Taking }): Action => {
  if (view === undefined || view.blocked) return pass
  if (view.subagent) return view.busy ? { _tag: "Interrupt", sessionID: view.sessionID } : pass
  const latest = view.latest
  if (!view.busy && latest?.pending !== true) return pass
  // A pending prompt is appended to whatever the composer holds; a sent one is taken back only into an empty composer.
  const takeBack = latest !== undefined && (latest.pending || (view.composer === "empty" && input.now - latest.created < input.grace))
  if (latest !== undefined && takeBack) {
    const taking = input.taking
    if (taking !== undefined && taking.messageID === latest.id && input.now - taking.at < SETTLE_MS) return { _tag: "Settling", sessionID: view.sessionID }
    return {
      _tag: "TakeBack",
      sessionID: view.sessionID,
      messageID: latest.id,
      pending: latest.pending,
      ranShell: latest.ranShell,
      stop: latest.pending && view.busy,
    }
  }
  return { _tag: "Interrupt", sessionID: view.sessionID }
}

// What one Escape does to the session on screen, decided without the host.
// Within the grace after the session's newest prompt was sent, Escape on an
// empty composer takes the prompt back: the run stops, the session reverts to
// before it and its text returns to the composer. After the grace, Escape
// interrupts and the prompt stays. A prompt still waiting in the session's
// inbox (queued, or a steer not yet delivered) comes back whatever the grace.
// A draft in the composer leaves the session alone; in a subagent's view,
// Escape interrupts that subagent. opencode/view.ts reads the view from the
// TUI's data; cmd/escape/setup.ts acts on the decision.

/** The default grace, in milliseconds (the plugin's `grace` option; 0 always interrupts). */
export const DEFAULT_GRACE_MS = 5_000

/** How long a take-back is assumed to be settling: a second Escape for the same prompt meanwhile is swallowed. */
export const SETTLE_MS = 10_000

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
  /** Stop the run, revert to before the prompt and put it back in the composer (the host's `session.undo`). */
  | { readonly _tag: "TakeBack"; readonly messageID: string; readonly pending: boolean; readonly ranShell: boolean }
  /** Stop the run; the prompt and its partial answer stay. */
  | { readonly _tag: "Interrupt"; readonly sessionID: string }
  /** Swallow the key: it means nothing to the session now, and nothing else should act on it. */
  | { readonly _tag: "Hold" }
  /** Leave the key to the host. */
  | { readonly _tag: "Pass" }

const pass: Action = { _tag: "Pass" }
const hold: Action = { _tag: "Hold" }

/** The decision for one Escape at `now`, given the grace and the take-back still settling, if any. */
export const decide = (view: View | undefined, input: { readonly now: number; readonly grace: number; readonly taking?: Taking }): Action => {
  if (view === undefined || view.blocked) return pass
  if (view.subagent) return view.busy ? { _tag: "Interrupt", sessionID: view.sessionID } : pass
  const latest = view.latest
  const engaged = view.busy || latest?.pending === true
  if (!engaged || view.composer === "none") return pass
  if (view.composer === "draft") return hold
  if (latest !== undefined && (latest.pending || input.now - latest.created < input.grace)) {
    const taking = input.taking
    if (taking !== undefined && taking.messageID === latest.id && input.now - taking.at < SETTLE_MS) return hold
    return { _tag: "TakeBack", messageID: latest.id, pending: latest.pending, ranShell: latest.ranShell }
  }
  return { _tag: "Interrupt", sessionID: view.sessionID }
}

/**
 * The escape plugin's setup, over the parts of the TUI plugin context it uses,
 * so the seam test can run it on a stand-in host. It adds two keymap layers
 * on Escape. In the base mode, above the host's own `session.interrupt` and
 * below the composer's own Escape layers (shell mode, the sidebar, a plugin
 * panel), it reads the session on screen (`opencode/view.ts`), decides
 * (`escape.ts`) and acts: a take-back runs the host's `session.undo`, which
 * interrupts, waits, reverts and puts the prompt back in the composer (or
 * takes a pending prompt back out of the inbox, the run it waited behind
 * interrupted beside it); an interrupt goes through the client. A refused
 * interrupt, or a session still running (or a prompt still queued) STOP_MS
 * after the press, is a toast, so a press the server never answers is never
 * silent. In the composer mode, the host's Subagents picker in a
 * subagent's view, it interrupts a busy subagent before the picker closes.
 * Anything Escape means nothing to falls through to the host.
 */
import { decide, DEFAULT_GRACE_MS, STOP_MS, type Taking } from "@dotfiles/opencode-escape/escape"
import { read, type Editor, type Reads, type Route } from "@dotfiles/opencode-escape/opencode/view"
import { Schema } from "effect"

/** The plugin's options: `grace`, the milliseconds after a send during which Escape takes the prompt back (0: never). */
export const Options = Schema.Struct({
  grace: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
})

/** The keymap layer shape the plugin registers, as far as it uses it. */
export interface Layer {
  readonly mode?: string
  readonly priority?: number
  readonly enabled?: () => boolean
  readonly commands: ReadonlyArray<{ readonly title: string; readonly group: string; readonly bind: string; readonly run: () => void | false }>
}

/** The parts of the TUI plugin context the plugin uses; `Plugin.Context` satisfies it. */
export interface Host {
  readonly options: Readonly<Record<string, unknown>>
  readonly data: Reads
  readonly renderer: { readonly currentFocusedEditor: Editor }
  readonly client: { readonly session: { interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown> } }
  readonly keymap: { layer(factory: () => Layer): void; dispatch(id: string): void }
  readonly ui: {
    readonly router: { current(): Route }
    readonly toast: { show(input: { message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }): void }
  }
}

/** The host command that takes the newest prompt back: interrupt, wait, revert and restore, or pull a pending one. */
export const UNDO = "session.undo"

/** The time the plugin reads and the timer it sets; a test supplies its own. */
export interface Clock {
  now(): number
  after(ms: number, run: () => void): void
}

const realClock: Clock = { now: Date.now, after: (ms, run) => void setTimeout(run, ms) }

/** The toast when the session still runs STOP_MS after an Escape asked it to stop. */
export const NOT_STOPPED = `Still running ${STOP_MS / 1000} s after Escape: the server has not stopped it (is it reachable?)`
/** The toast when a pending prompt is still in the inbox STOP_MS after an Escape took it back. */
export const NOT_TAKEN = `Still queued ${STOP_MS / 1000} s after Escape: the server has not taken the prompt back (is it reachable?)`
/** The toast for an Escape while the take-back it repeats is still settling. */
export const SETTLING = "Still taking the prompt back"

export const setup = (host: Host, clock: Clock = realClock) => {
  const grace = Schema.decodeUnknownSync(Options)(host.options).grace ?? DEFAULT_GRACE_MS
  let taking: Taking | undefined
  const toast = (message: string, variant: "info" | "warning" | "error") => host.ui.toast.show({ message, variant, duration: 5_000 })
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const running = (sessionID: string) => host.data.session.status(sessionID) === "running"
  const pending = (sessionID: string, messageID: string) => host.data.session.pending.list(sessionID).some((item) => item.id === messageID)

  /** Interrupts `sessionID`; a refusal says why, and a run still going STOP_MS later says the server has not stopped it. */
  const interrupt = (sessionID: string, resume: boolean) => {
    let refused = false
    void host.client.session.interrupt({ sessionID, resume }).catch((error: unknown) => {
      refused = true
      toast(`Could not interrupt: ${errorText(error)}`, "error")
    })
    clock.after(STOP_MS, () => {
      if (!refused && running(sessionID)) toast(NOT_STOPPED, "error")
    })
  }

  const escape = () => {
    const at = clock.now()
    const action = decide(read(host.data, host.ui.router.current(), host.renderer.currentFocusedEditor), { now: at, grace, taking })
    switch (action._tag) {
      case "Pass":
        return false
      case "Settling":
        toast(SETTLING, "info")
        return
      case "Interrupt":
        interrupt(action.sessionID, true)
        return
      case "TakeBack": {
        taking = { messageID: action.messageID, at }
        const { sessionID } = action
        // The host's undo puts the prompt back in the composer: for a pending one it cancels it in the inbox, for a
        // sent one it interrupts, waits, and reverts. Its own failures are its toasts; a hang is ours below.
        host.keymap.dispatch(UNDO)
        // A pending prompt waited behind a run: stop that too, without resuming the inbox ahead of the cancel.
        if (action.stop) interrupt(sessionID, false)
        else
          clock.after(STOP_MS, () => {
            if (action.pending ? pending(sessionID, action.messageID) : running(sessionID)) toast(action.pending ? NOT_TAKEN : NOT_STOPPED, "error")
          })
        // A revert restores files, not what a shell command did outside them.
        if (action.ranShell && !action.pending) toast("Cancelled; shell commands it ran are not undone", "warning")
        return
      }
    }
  }

  const route = () => host.ui.router.current()
  const subagent = () => {
    const current = route()
    return current.type === "session" && "sessionID" in current && host.data.session.get(current.sessionID)?.parentID !== undefined
  }
  // Priority 1 is the composer's: above the host's session.interrupt (0); the composer's own Escape layers (shell mode)
  // and a focused plugin panel's, registered later at the same priority, still come first.
  host.keymap.layer(() => ({
    priority: 1,
    commands: [{ title: "Take back or interrupt", group: "Session", bind: "escape", run: escape }],
  }))
  // The Subagents picker stands in for the composer in a subagent's view; its Escape (priority 1) closes it.
  host.keymap.layer(() => ({
    mode: "composer",
    priority: 2,
    enabled: subagent,
    commands: [{ title: "Interrupt the subagent", group: "Session", bind: "escape", run: escape }],
  }))
}

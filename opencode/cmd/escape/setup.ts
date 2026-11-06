/**
 * The escape plugin's setup, over the parts of the TUI plugin context it uses,
 * so the seam test can run it on a stand-in host. It adds two keymap layers
 * on Escape. In the base mode, above the host's own `session.interrupt` and
 * below the composer's own Escape layers (shell mode, the sidebar, a plugin
 * panel), it reads the session on screen (`opencode/view.ts`), decides
 * (`escape.ts`) and acts: a take-back runs the host's `session.undo`, which
 * interrupts, waits, reverts and puts the prompt back in the composer (or
 * takes a pending prompt back out of the inbox); an interrupt goes through
 * the client. In the composer mode, the host's Subagents picker in a
 * subagent's view, it interrupts a busy subagent before the picker closes.
 * Anything Escape means nothing to falls through to the host.
 */
import { decide, DEFAULT_GRACE_MS, type Taking } from "@dotfiles/opencode-escape/escape"
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

export const setup = (host: Host, now: () => number = Date.now) => {
  const grace = Schema.decodeUnknownSync(Options)(host.options).grace ?? DEFAULT_GRACE_MS
  let taking: Taking | undefined
  const failed = (error: unknown) =>
    host.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error", duration: 5_000 })

  const escape = () => {
    const at = now()
    const action = decide(read(host.data, host.ui.router.current(), host.renderer.currentFocusedEditor), { now: at, grace, taking })
    switch (action._tag) {
      case "Pass":
        return false
      case "Hold":
        return
      case "Interrupt":
        void host.client.session.interrupt({ sessionID: action.sessionID, resume: true }).catch(failed)
        return
      case "TakeBack":
        taking = { messageID: action.messageID, at }
        host.keymap.dispatch(UNDO)
        // A revert restores files, not what a shell command did outside them.
        if (action.ranShell && !action.pending)
          host.ui.toast.show({ message: "Cancelled; shell commands it ran are not undone", variant: "warning", duration: 5_000 })
        return
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

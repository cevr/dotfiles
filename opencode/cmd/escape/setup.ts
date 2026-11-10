/**
 * The escape plugin's setup, over the parts of the TUI plugin context it uses,
 * so the seam test can run it on a stand-in host. It adds one keymap layer
 * on Escape. In the base mode, above the host's own `session.interrupt` and
 * below the composer's own Escape layers (shell mode, the sidebar, a plugin
 * panel), it reads the session on screen (`opencode/view.ts`), decides
 * (`escape.ts`) and acts: a take-back runs the host's `session.undo`, which
 * interrupts, waits, reverts and puts the prompt back in the composer (or
 * takes a pending prompt back out of the inbox, the run it waited behind
 * interrupted beside it); an interrupt goes through the client. A refused
 * interrupt, or a turn not stopped (or a prompt still queued) STOP_MS after
 * the press, is a toast, so a press the server never answers is never
 * silent; the next turn a resume or a sent prompt starts is not the stopped
 * one. It adds nothing in the composer mode: an open panel (the Subagents
 * picker a subagent's view opens on, a plugin tab) owns Escape and only puts
 * itself away, so the prompt under it can message the subagent; the next
 * Escape, with nothing open, goes back to the parent (the host's
 * `session.parent`) and never interrupts the subagent. Anything Escape means
 * nothing to falls through to the host.
 *
 * A second layer, in the base mode above the composer's own Ctrl+Enter (a
 * newline), adds Ctrl+Enter: interrupt the turn and send what waits
 * (`send.ts`), in a subagent's view too. A draft goes to the queue through the host's own
 * `prompt.queue` (attachments and all), the turn is interrupted once that
 * prompt is in the inbox, and the waiting prompts go out as `plan` orders;
 * on an idle session it is the host's `prompt.submit`, as Enter.
 */
import { decide, DEFAULT_GRACE_MS, hung, STOP_MS, type Taking } from "@dotfiles/opencode-escape/escape"
import { read, waiting, type Editor, type Reads, type Route } from "@dotfiles/opencode-escape/opencode/view"
import { decideSend, plan, SEND_COMMAND, SEND_FALLBACK, SEND_KEY, type Waiting } from "@dotfiles/opencode-escape/send"
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
  readonly commands: ReadonlyArray<{
    readonly id?: string
    readonly title: string
    readonly group: string
    readonly bind: string
    readonly run: () => void | false
  }>
}

/** The host's event that a prompt reached a session's inbox, as far as the plugin reads it. */
export interface Enqueued {
  readonly data: { readonly sessionID: string; readonly inboxID: string; readonly item: { readonly type: string } }
}

/** The host's events that a session's turn ended: it finished, failed or was interrupted. */
export const ENDED = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const

/** One of the `ENDED` events, as far as the plugin reads it. */
export interface Ended {
  readonly data: { readonly sessionID: string }
}

/** The host's events the plugin hears, by type. */
export type Events = { readonly "session.inbox.enqueued": Enqueued } & { readonly [Type in (typeof ENDED)[number]]: Ended }

/** The parts of the TUI plugin context the plugin uses; `Plugin.Context` satisfies it. */
export interface Host {
  readonly options: Readonly<Record<string, unknown>>
  readonly data: Reads & { on<Type extends keyof Events>(type: Type, handler: (event: Events[Type]) => void): () => void }
  readonly renderer: { readonly currentFocusedEditor: Editor }
  readonly client: {
    readonly session: {
      interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>
      readonly inbox: { update(input: { sessionID: string; inboxID: string; delivery: "steer" | "queue" }): Promise<unknown> }
    }
  }
  readonly keymap: { layer(factory: () => Layer): void; dispatch(id: string): void }
  readonly ui: {
    readonly router: { current(): Route }
    readonly toast: { show(input: { message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }): void }
  }
}

/** The host command that takes the newest prompt back: interrupt, wait, revert and restore, or pull a pending one. */
export const UNDO = "session.undo"
/** The host command Enter runs: send the composer (a steer while the session runs). */
export const SUBMIT = "prompt.submit"
/** The host command leader+Enter runs: send the composer to the queue, for after the turn. */
export const QUEUE = "prompt.queue"
/** The host command that shows a subagent's parent session (↑ past the first row). */
export const PARENT = "session.parent"

/** The time the plugin reads and the timer it sets; a test supplies its own. */
export interface Clock {
  now(): number
  after(ms: number, run: () => void): void
}

const realClock: Clock = { now: Date.now, after: (ms, run) => void setTimeout(run, ms) }

/** The toast when the session still runs STOP_MS after `key` asked it to stop. */
export const notStopped = (key: string) => `Still running ${STOP_MS / 1000} s after ${key}: the server has not stopped it (is it reachable?)`
/** The toast when the session still runs STOP_MS after an Escape asked it to stop. */
export const NOT_STOPPED = notStopped("Escape")
/** The toast when a pending prompt is still in the inbox STOP_MS after an Escape took it back. */
export const NOT_TAKEN = `Still queued ${STOP_MS / 1000} s after Escape: the server has not taken the prompt back (is it reachable?)`
/** The toast for an Escape while the take-back it repeats is still settling. */
export const SETTLING = "Still taking the prompt back"
/** The toast when Ctrl+Enter's draft never reached the inbox (the host refused to queue it, or the server did not answer): nothing was interrupted. */
export const NOT_QUEUED = "Not interrupted: the prompt did not reach the queue"
/** The toast for a Ctrl+Enter while the one before it is still sending. */
export const SENDING = "Still sending the queued prompts"

export const setup = (host: Host, clock: Clock = realClock) => {
  const grace = Schema.decodeUnknownSync(Options)(host.options).grace ?? DEFAULT_GRACE_MS
  let taking: Taking | undefined
  const toast = (message: string, variant: "info" | "warning" | "error") => host.ui.toast.show({ message, variant, duration: 5_000 })
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const running = (sessionID: string) => host.data.session.status(sessionID) === "running"
  const pending = (sessionID: string, messageID: string) => host.data.session.pending.list(sessionID).some((item) => item.id === messageID)

  /**
   * Watches the turn `sessionID` runs now, and runs `report` when it has not
   * stopped STOP_MS later (`hung`): the server never said it ended and the
   * session still runs. The next turn, which a resume or a sent prompt starts
   * at once, is not the one watched.
   */
  const watch = (sessionID: string, report: () => void) => {
    let ended = false
    const offs = ENDED.map((type) =>
      host.data.on(type, (event) => {
        if (event.data.sessionID === sessionID) ended = true
      }),
    )
    clock.after(STOP_MS, () => {
      for (const off of offs) off()
      if (hung({ ended, running: running(sessionID) })) report()
    })
  }

  /**
   * Interrupts `sessionID`; a refusal says why, and a turn not stopped
   * STOP_MS later says the server has not stopped it. Resolves whether the
   * server took the interrupt.
   */
  const interrupt = (sessionID: string, resume: boolean, key = "Escape") => {
    let refused = false
    // Before the call: the turn may end before the server's answer arrives.
    watch(sessionID, () => {
      if (!refused) toast(notStopped(key), "error")
    })
    return host.client.session.interrupt({ sessionID, resume }).then(
      () => true,
      (error: unknown) => {
        refused = true
        toast(`Could not interrupt: ${errorText(error)}`, "error")
        return false
      },
    )
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
        void interrupt(action.sessionID, true)
        return
      case "Parent":
        // The host's own ↑ past the first row: the subagent keeps running, and what was sent to it still reaches it.
        host.keymap.dispatch(PARENT)
        return
      case "TakeBack": {
        taking = { messageID: action.messageID, at }
        const { sessionID } = action
        // The host's undo puts the prompt back in the composer: for a pending one it cancels it in the inbox, for a
        // sent one it interrupts, waits, and reverts. Its own failures are its toasts; a hang is ours below.
        host.keymap.dispatch(UNDO)
        // A pending prompt waited behind a run: stop that too, without resuming the inbox ahead of the cancel.
        if (action.stop) void interrupt(sessionID, false)
        else if (action.pending)
          clock.after(STOP_MS, () => {
            if (pending(sessionID, action.messageID)) toast(NOT_TAKEN, "error")
          })
        else watch(sessionID, () => toast(NOT_STOPPED, "error"))
        // A revert restores files, not what a shell command did outside them.
        if (action.ranShell && !action.pending) toast("Cancelled; shell commands it ran are not undone", "warning")
        return
      }
    }
  }

  /**
   * Sends the composer to the session's queue through the host's own
   * `prompt.queue`, and resolves the id of the prompt it put in the inbox
   * once the server has admitted it, or undefined when none arrives within
   * STOP_MS (the host refused it with a toast of its own, or the server did
   * not answer).
   */
  const queueDraft = (sessionID: string) =>
    new Promise<string | undefined>((resolve) => {
      const before = new Set(host.data.session.pending.list(sessionID).map((item) => item.id))
      let settled = false
      let off = () => {}
      const settle = (id: string | undefined) => {
        if (settled) return
        settled = true
        off()
        resolve(id)
      }
      off = host.data.on("session.inbox.enqueued", (event) => {
        const { data } = event
        if (data.sessionID === sessionID && data.item.type === "user" && !before.has(data.inboxID)) settle(data.inboxID)
      })
      host.keymap.dispatch(QUEUE)
      clock.after(STOP_MS, () => settle(undefined))
    })

  /** Moves one waiting prompt to the steers; a refusal for a prompt still waiting says why, one the session already took is no news. */
  const promote = (sessionID: string, inboxID: string) =>
    host.client.session.inbox.update({ sessionID, inboxID, delivery: "steer" }).catch((error: unknown) => {
      if (pending(sessionID, inboxID)) toast(`Could not send a queued prompt: ${errorText(error)}`, "error")
    })

  /** Ctrl+Enter on a busy session: the draft to the queue, then the interrupt, then the waiting prompts out (send.ts `plan`). */
  const interruptSend = async (sessionID: string, draft: boolean) => {
    const prompts: Array<Waiting> = [...waiting(host.data, sessionID)]
    if (draft) {
      const id = await queueDraft(sessionID)
      if (id === undefined) return toast(NOT_QUEUED, "warning")
      // The host's data may take the same event after this plugin: the draft is known queued, whatever the list says yet.
      if (!prompts.some((item) => item.id === id)) prompts.push({ id, delivery: "queue" })
    }
    const order = plan(prompts)
    if (!(await interrupt(sessionID, order.resume, "Ctrl+Enter"))) return
    // The server has taken the interrupt: the stopping turn takes no new work, and each move rings for the turn after
    // it, which starts once the stopping one settles and takes every steer then waiting. One at a time keeps the order.
    for (const inboxID of order.promote) await promote(sessionID, inboxID)
  }

  let sending = false
  const send = () => {
    const view = read(host.data, host.ui.router.current(), host.renderer.currentFocusedEditor)
    const action = decideSend(view, view === undefined ? [] : waiting(host.data, view.sessionID))
    switch (action._tag) {
      case "Pass":
        return false
      case "Nothing":
        return
      case "Submit":
        host.keymap.dispatch(SUBMIT)
        return
      case "InterruptSend":
        if (sending) return toast(SENDING, "info")
        sending = true
        void interruptSend(action.sessionID, action.draft).finally(() => {
          sending = false
        })
        return
    }
  }

  // Priority 1 is the composer's: above the host's session.interrupt (0); the composer's own Escape layers (shell mode)
  // and a focused plugin panel's, registered later at the same priority, still come first. Nothing in another mode: an
  // open panel (the composer panel, a dialog, a form) pushes its own mode and owns Escape, which puts it away.
  host.keymap.layer(() => ({
    priority: 1,
    commands: [{ title: "Take back or interrupt", group: "Session", bind: "escape", run: escape }],
  }))
  // Ctrl+Enter, above the composer's own (a newline, the managed textarea's layer at 0), and leader+F for a terminal
  // that sends Ctrl+Enter as Enter; an id so a hint can name its key.
  host.keymap.layer(() => ({
    priority: 1,
    commands: [{ id: SEND_COMMAND, title: "Interrupt and send", group: "Session", bind: `${SEND_KEY},${SEND_FALLBACK}`, run: send }],
  }))
}

/**
 * The orchestrate rules' TUI plugin: it tells the server half when the owner
 * drafts a prompt to a root, so an idle root is never nudged while the owner
 * writes to it (`@dotfiles/opencode-orchestrate/idle`). The composition root
 * of the TUI half; it draws nothing.
 *
 * After each key or paste (once the composer has taken it) and every
 * `HEARTBEAT_MS`, it looks at the route's root session and the focused
 * editor's text (`renderer.currentFocusedEditor`, as the questions' hotkey
 * reads the composer) and sends what `reportsOf` says over the idle RPC
 * (`IDLE.draft`), under one client id per TUI. A report that fails is
 * dropped: the server forgets a draft not reported again within
 * `DRAFT_TTL_MS`.
 */
import { Plugin } from "@opencode/plugin/tui"
import { HEARTBEAT_MS, IDLE, type Reported, reportsOf } from "@dotfiles/opencode-orchestrate/idle"

/** What the reporter reads of the TUI: the parts of its context it touches. */
export type Host = Pick<Plugin.Context, "location"> & {
  readonly renderer: {
    readonly keyInput: {
      on(event: "keypress" | "paste", listener: () => void): unknown
      off(event: "keypress" | "paste", listener: () => void): unknown
    }
    readonly currentFocusedEditor: { readonly plainText: string } | null
  }
  readonly ui: { readonly router: { current(): { readonly type: string; readonly sessionID?: string } } }
  readonly data: { readonly session: { root(sessionID: string): string } }
  readonly client: {
    rpc(definition: typeof IDLE): {
      draft(input: { readonly sessionID: string; readonly client: string; readonly drafting: boolean }, options: { readonly location: Plugin.Context["location"] }): Promise<unknown>
    }
  }
}

/** Start reporting drafts; the cleanup stops it. */
export const report = (ctx: Host, client: string = crypto.randomUUID(), now: () => number = Date.now) => {
  let last: Reported | undefined
  const look = () => {
    const route = ctx.ui.router.current()
    const sessionID = route.type === "session" && route.sessionID !== undefined ? ctx.data.session.root(route.sessionID) : undefined
    const drafting = (ctx.renderer.currentFocusedEditor?.plainText ?? "").trim() !== ""
    const at = now()
    for (const draft of reportsOf(last, { sessionID, drafting }, at)) {
      last = draft.drafting ? { sessionID: draft.sessionID, at } : undefined
      void ctx.client
        .rpc(IDLE)
        .draft({ ...draft, client }, { location: ctx.location })
        .catch(() => undefined)
    }
  }
  // The editor takes the key in the same dispatch; read its text once it has.
  const later = () => void setTimeout(look, 0)
  ctx.renderer.keyInput.on("keypress", later)
  ctx.renderer.keyInput.on("paste", later)
  const timer = setInterval(look, HEARTBEAT_MS)
  return () => {
    clearInterval(timer)
    ctx.renderer.keyInput.off("keypress", later)
    ctx.renderer.keyInput.off("paste", later)
  }
}

export default Plugin.define({
  id: IDLE.id,
  setup: (ctx) => report(ctx),
})

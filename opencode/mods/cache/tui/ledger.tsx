// The cache ledger the row and the sidebar both read: each session's judged
// misses, from the TUI's session data (opencode/view.ts) and the approval
// waits this TUI saw. Approval waits leave no record in the session's
// messages (the fork's `permission.asked` and `permission.replied` events are
// ephemeral), so a wait this TUI did not see while it happened reads as the
// tool call it held up. A subagent's messages are fetched when the sidebar
// asks for them and again when one of its steps ends: the TUI holds only the
// sessions it shows.
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { judge, missedUsd, turnRows, type Judged } from "../ledger.ts"
import { sidebarText } from "../line.ts"
import type { Span, Timeline } from "../miss.ts"
import { descendants, hits, sessionCatalog, timeline } from "../opencode/view.ts"

export interface Ledger {
  /** The rows of the turn `messageID` of `sessionID` closes. Reactive. */
  rows(sessionID: string, messageID: string): ReadonlyArray<string>
  /** The sidebar line of `sessionID` and every session under it; undefined before any cache activity. Reactive. */
  sidebar(sessionID: string): string | undefined
  /** Stop listening. */
  dispose(): void
}

export function createLedger(ctx: Plugin.Context): Ledger {
  const [waits, setWaits] = createSignal<Readonly<Record<string, ReadonlyArray<Span>>>>({})
  const asked = new Map<string, { readonly sessionID: string; readonly at: number }>()
  const fetched = new Set<string>()
  const unsubscribe = [
    ctx.data.on("permission.asked", (event) => {
      asked.set(event.data.id, { sessionID: event.data.sessionID, at: Date.now() })
    }),
    ctx.data.on("permission.replied", (event) => {
      const open = asked.get(event.data.requestID)
      if (open === undefined) return
      asked.delete(event.data.requestID)
      const span: Span = { name: "approval", at: open.at, ms: Date.now() - open.at }
      setWaits((all) => ({ ...all, [open.sessionID]: [...(all[open.sessionID] ?? []), span] }))
    }),
    // A subagent's new step: fetch its messages again, if the sidebar reads them.
    ctx.data.on("session.step.ended", (event) => {
      if (fetched.has(event.data.sessionID)) void ctx.data.session.message.sync(event.data.sessionID).catch(() => undefined)
    }),
  ]

  const sessionTimeline = (sessionID: string): Timeline => timeline(ctx.data.session.message.list(sessionID))
  const judged = (sessionID: string): ReadonlyArray<Judged> => {
    const terms = sessionCatalog(ctx.data, sessionID)
    return judge(sessionTimeline(sessionID), waits()[sessionID] ?? [], (model) => terms.get(model))
  }

  return {
    rows: (sessionID, messageID) => turnRows(sessionTimeline(sessionID), judged(sessionID), messageID),
    sidebar(sessionID) {
      const ids = descendants(ctx.data, sessionID)
      for (const id of ids)
        if (id !== sessionID && !fetched.has(id)) {
          fetched.add(id)
          void ctx.data.session.message.sync(id).catch(() => undefined)
        }
      return sidebarText(hits(ctx.data, ids), missedUsd(ids.map(judged)))
    },
    dispose() {
      for (const stop of unsubscribe) stop()
    },
  }
}

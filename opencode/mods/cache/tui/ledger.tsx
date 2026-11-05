// The cache ledger the row and the sidebar both read: each session's judged
// misses, from the TUI's session data (opencode/view.ts) and the approval
// waits this TUI saw. Approval waits leave no record in the session's
// messages (the fork's `permission.asked` and `permission.replied` events are
// ephemeral), so a wait this TUI did not see while it happened reads as the
// tool call it held up. A subagent's messages are fetched when the sidebar
// asks for them and again when one of its steps ends: the TUI holds only the
// sessions it shows. The login each step went out on comes from the pool's
// `logins` RPC, asked when a session is first read and again when one of its
// steps ends; an answer that fails or does not decode names no login, and the
// misses read as if the pool had kept every step on one. Each agent's own cache
// lifetime comes from the location's agent list.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createSignal } from "solid-js"
import { POOL_STATUS, SessionLogins } from "@dotfiles/opencode-pool/status"
import { judge, missedUsd, turnRows, type Judged } from "../ledger.ts"
import { sidebarText } from "../line.ts"
import type { Span, Timeline } from "../miss.ts"
import { descendants, hits, sessionAgentTtls, sessionCatalog, timeline } from "../opencode/view.ts"

const decodeLogins = Schema.decodeUnknownOption(SessionLogins)

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
  const [logins, setLogins] = createSignal<Readonly<Record<string, ReadonlyMap<string, string>>>>({})
  const asking = new Set<string>()
  const abort = new AbortController()
  const askLogins = (sessionID: string) =>
    void ctx.client
      .rpc(POOL_STATUS)
      .logins({ sessionID }, { location: ctx.location, signal: abort.signal })
      .then(
        (value) => Option.map(decodeLogins(value), (answer) => new Map(answer.steps.map((step) => [step.messageID, step.credentialID] as const))),
        () => Option.none<ReadonlyMap<string, string>>(),
      )
      .then((found) => {
        if (abort.signal.aborted || Option.isNone(found)) return
        setLogins((all) => ({ ...all, [sessionID]: found.value }))
      })
  const sessionLogins = (sessionID: string): ReadonlyMap<string, string> => {
    if (!asking.has(sessionID)) {
      asking.add(sessionID)
      askLogins(sessionID)
    }
    return logins()[sessionID] ?? new Map()
  }
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
    // Any session's new step: ask the pool again where it went out.
    ctx.data.on("session.step.ended", (event) => {
      if (fetched.has(event.data.sessionID)) void ctx.data.session.message.sync(event.data.sessionID).catch(() => undefined)
      if (asking.has(event.data.sessionID)) askLogins(event.data.sessionID)
    }),
  ]

  const sessionTimeline = (sessionID: string): Timeline => timeline(ctx.data.session.message.list(sessionID), sessionLogins(sessionID))
  const judged = (sessionID: string): ReadonlyArray<Judged> => {
    const terms = sessionCatalog(ctx.data, sessionID)
    const ttls = sessionAgentTtls(ctx.data, sessionID)
    return judge(
      sessionTimeline(sessionID),
      waits()[sessionID] ?? [],
      (model) => terms.get(model),
      (agent) => ttls.get(agent),
    )
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
      abort.abort()
      for (const stop of unsubscribe) stop()
    },
  }
}

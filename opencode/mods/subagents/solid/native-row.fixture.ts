// The pinned-host suite loads this adapter from the Solid project so it uses
// the same dependency resolution and reactive build as the TUI.
import { createComputed, createMemo, createRoot, getOwner, runWithOwner } from "solid-js"
import { Array as Arr, Effect, Option, Result, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/tui"
import { ownerRows, rowView } from "./owner-rows.ts"
import { decodeEvent, durableFact } from "../../kernel/opencode/child-lifecycle.ts"
import { Fact, Undetermined, evolve, initial, rowFactOf } from "../../kernel/child-lifecycle.ts"
import { readMark } from "../../wake/latch.ts"
import { sessionOf, shellsBySession, type Reads, type SessionInfo, type ShellInfo } from "../opencode/view.ts"
import { subagents, visible } from "../subagent-row.ts"

export const liveEvents = (events: { subscribe(options: { readonly signal: AbortSignal }): AsyncIterable<object> }) => {
  let listeners = 0
  const listen: NonNullable<Reads["listen"]> = (take) => {
    const controller = new AbortController()
    listeners++
    Stream.fromAsyncIterable(events.subscribe({ signal: controller.signal }), String).pipe(
      Stream.runForEach((details) => Effect.sync(() => take({ details }))),
      Effect.ignore,
      Effect.runFork,
    )
    return () => {
      controller.abort()
      listeners--
    }
  }
  return { listen, listeners: () => listeners }
}

export const mountRows = (data: Reads, base: string, root: string, child: string, client: Pick<Plugin.Context["client"], "rpc">) => {
  const reader = ownerRows({ data, client, location: { directory: base } })
  return createRoot((close) => {
    const scope = getOwner()
    const family = createMemo(() => reader(data, root))
    const ready = Effect.callback<void>((resume) => {
      runWithOwner(scope, () => createComputed(() => {
        const fact = family().sessions.find(({ id }) => id === child)?.execution
        if (fact && fact.kind !== "checking") resume(Effect.void)
      }))
    })
    const rows = () => subagents(family(), root)
    return { close, ready, rows }
  })
}

/** Compare the actual native messages at their stream boundaries, without
 * making network calls in the few milliseconds before the next phase. */
export const replayRows = (
  failed: SessionInfo, root: string, shell: ShellInfo, events: ReadonlyArray<unknown>,
): ReadonlyArray<string> => {
  let state = initial(failed.id, root)
  let running = false
  let shells = shellsBySession([shell]).get(failed.id) ?? []
  const pending = new Map<string, { readonly type: string; readonly payload: object }>()
  const reads: Pick<Reads, "session"> = { session: {
    get: () => failed, root: () => root, family: () => [root, failed.id],
    status: () => {
      if (running) return "running"
      return "idle"
    },
    pending: { list: () => [...pending.values()] },
    message: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] },
  } }
  return Arr.flatMap(events, (event) => {
    const decoded = decodeEvent(event)
    if (Result.isFailure(decoded)) return ["invalid native event"]
    const host = decoded.success
    Option.map(durableFact(host, root), (fact) => { state = evolve(state, fact) })
    if (host.type === "shell.exited" && host.data.id === shell.id) {
      const reason = Undetermined.make({ shellID: shell.id, exit: { id: host.id, at: host.created } })
      state = evolve(state, Fact.cases.Exit.make({ child: failed.id, parent: root, reason }))
    }
    if (host.type === "shell.created") return []
    if (host.type === "shell.exited") shells = []
    if (host.type === "session.execution.started") running = true
    if (host.type === "session.inbox.enqueued") pending.set(host.data.inboxID, host.data.item)
    if (host.type === "session.inbox.delivered") pending.delete(host.data.inboxID)
    const row = sessionOf(reads, failed.id, shells, { messages: [] }, rowView({
      child: failed.id, mark: readMark(failed.metadata), fact: rowFactOf(state, { running }),
    }))
    return visible(subagents({ root, sessions: [row] }, root), host.created + 1).map(({ state, update }) => {
      if (update.startsWith("Undetermined:")) return "undetermined"
      return state
    })
  })
}

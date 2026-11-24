// The pinned-host suite loads this adapter from the Solid project so it uses
// the same dependency resolution and reactive build as the TUI.
import { createComputed, createMemo, createRoot, createSignal, getOwner, runWithOwner } from "solid-js"
import { Array as Arr, Deferred, Effect, Option, Queue, Result, Stream } from "effect"
import { ownerRows, rowView, type RowsClient } from "./owner-rows.ts"
import { CHILD_ROWS, readRows } from "../../kernel/opencode/child-row.ts"
import { decodeEvent, durableFact, ownerAnswer } from "../../kernel/opencode/child-lifecycle.ts"
import { Fact, Undetermined, evolve, initial, present } from "../../kernel/child-lifecycle.ts"
import { readMark } from "../../wake/latch.ts"
import { ownedSessionOf, type Reads, type SessionInfo, type ShellInfo } from "../opencode/view.ts"
import { subagents, visible } from "../subagent-row.ts"
import { worksNow } from "../works.ts"

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

export const mountRows = (data: Reads, base: string, root: string, child: string, client: RowsClient) => {
  const reader = ownerRows({ data, client, location: { directory: base } })
  return createRoot((close) => {
    const scope = getOwner()
    const family = createMemo(() => reader(data, root))
    const owner = () => family().sessions.find(({ id }) => id === child)?.lifecycle
    const whenOwner = (matches: (state: ReturnType<typeof owner>) => boolean) => Effect.callback<void>((resume) => {
      runWithOwner(scope, () => createComputed(() => {
        if (matches(owner())) resume(Effect.void)
      }))
    })
    const ready = whenOwner((state) => Boolean(state && state.kind !== "checking"))
    const fallback = whenOwner((state) => Option.isNone(Option.fromUndefinedOr(state)))
    const rows = () => subagents(family(), root)
    const active = () => Option.isSome(Option.fromUndefinedOr(worksNow(family())(child)))
    return { close, ready, rows, owner, active, fallback }
  })
}

const manualTransport = (client: RowsClient, base: string, root: string, child: string, info: SessionInfo, shell?: ShellInfo) =>
  Effect.gen(function* () {
    const flights = yield* Queue.unbounded<{ readonly revision: number; readonly release: Effect.Effect<boolean> }>()
    const listeners = new Set<(event: { details: object }) => void>()
    const [processes, setProcesses] = createSignal<ReadonlyArray<ShellInfo>>(Option.toArray(Option.fromUndefinedOr(shell)))
    const transport: RowsClient = { rpc: () => ({
      read: (input, options) => Effect.runPromise(Effect.gen(function* () {
        const release = yield* Deferred.make<boolean>()
        const response = yield* Effect.tryPromise(() => client.rpc(CHILD_ROWS).read(input, options))
        const decoded = yield* Effect.fromOption(readRows(response))
        const row = yield* Effect.fromOption(Option.fromUndefinedOr(decoded.rows.find(({ child: id }) => id === child)))
        yield* Queue.offer(flights, { revision: row.observation.revision, release: Deferred.succeed(release, true) })
        yield* Deferred.await(release)
        return response
      }), { signal: options.signal }),
    }) }
    const reads: Reads = {
      session: {
        get: () => info, root: () => root, family: () => [root, child],
        status: () => "idle", message: { list: () => [] },
        permission: { list: () => [] }, form: { list: () => [] },
      },
      shell: { list: processes },
      listen: (take) => { listeners.add(take); return () => { listeners.delete(take) } },
    }
    const view = mountRows(reads, base, root, child, transport)
    return {
      view, next: Queue.take(flights), hideShell: () => setProcesses([]),
      notify: (details: { readonly type: string }) => listeners.forEach((take) => take({ details })),
      listeners: () => listeners.size,
    }
  })

/** The real RPC reads the real owner before the fixture withholds the wire reply. */
export const openBarrier = (client: RowsClient, base: string, root: string, child: string, info: SessionInfo, shell?: ShellInfo) =>
  Effect.gen(function* () {
    const observer = yield* Effect.acquireRelease(manualTransport(client, base, root, child, info, shell),
      ({ view }) => Effect.sync(view.close))
    const initial = yield* observer.next
    yield* initial.release
    yield* observer.view.ready
    const snapshot = () => observer.view.rows().map(({ state, update }) => ({ state, update }))
    return {
      notify: observer.notify, hideShell: observer.hideShell, next: observer.next,
      live: snapshot(), snapshot, revision: () => Number(observer.view.owner()?.revision), ready: observer.view.ready,
      initial: initial.revision, listeners: observer.listeners, active: observer.view.active, fallback: observer.view.fallback,
    }
  })

/** Compare the actual native messages at their stream boundaries, without
 * making network calls in the few milliseconds before the next phase. */
export const replayRows = (
  failed: SessionInfo, root: string, shell: ShellInfo, events: ReadonlyArray<unknown>,
): ReadonlyArray<string> => {
  let state = initial(failed.id, root)
  let running = false
  return Arr.flatMap(events, (event) => {
    const decoded = decodeEvent(event)
    if (Result.isFailure(decoded)) return ["invalid native event"]
    const host = decoded.success
    Option.map(durableFact(host, root), (fact) => { state = evolve(state, { ...fact, seenIn: 1 }) })
    if (host.type === "shell.exited" && host.data.id === shell.id) {
      const reason = Undetermined.make({ shellID: shell.id, exit: { id: host.id, at: host.created } })
      state = evolve(state, { ...Fact.cases.Exit.make({ child: failed.id, parent: root, reason }), seenIn: 1 })
    }
    if (host.type === "shell.created") {
      state = evolve(state, { ...Fact.cases.Work.make({
        child: failed.id, parent: root, id: shell.id,
        work: { kind: "Shell", native: true, backgrounded: true, running: true, at: host.created },
      }), seenIn: 1 })
      return []
    }
    if (host.type === "session.execution.started") running = true
    const view = present(state, { running }, 1)
    const row = ownedSessionOf(failed.id, { messages: [] }, failed, rowView(ownerAnswer(view, readMark(failed.metadata), host.created, state.rev)))
    return visible(subagents({ root, sessions: [row] }, root), host.created + 1).map(({ state, update }) => {
      if (update.startsWith("Undetermined:")) return "undetermined"
      return state
    })
  })
}

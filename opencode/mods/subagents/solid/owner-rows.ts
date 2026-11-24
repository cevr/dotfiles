import type { Plugin } from "@opencode/plugin/tui"
import { Effect, Match, Option, Schema } from "effect"
import { CHILD_ROWS, readRows, rowsChanged, type OwnerAnswer, type RowsReply } from "../../kernel/opencode/child-row.ts"
import { readerWithOwner, type FamilyReader, type FollowRows } from "./reader.ts"
import type { Lifecycle, OwnedRow } from "../family.ts"

const metadataChanged = Schema.decodeUnknownOption(Schema.Struct({
  type: Schema.Literal("session.metadata.updated"),
  data: Schema.Struct({ sessionID: Schema.String }),
}))
const connected = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("server.connected") }))
const hostWork = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literals([
  "shell.created", "shell.deleted", "shell.exited", "experimental.job.updated",
  "session.execution.started", "session.execution.failed", "session.execution.succeeded", "session.execution.interrupted",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled",
  "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
]) }))
const readers = new WeakMap<object, FamilyReader>()
export type RowsClient = {
  readonly rpc: (contract: typeof CHILD_ROWS) => {
    readonly read: (
      input: { readonly children: ReadonlyArray<string> },
      options: { readonly location: Plugin.Context["location"]; readonly signal: AbortSignal },
    ) => PromiseLike<RowsReply>
  }
}

const unanswered = (child: string, revision: number): OwnedRow => ({
  child, lifecycle: { kind: "unknown", revision, at: 0, sinceReload: false, waitingOn: "", diagnostic: false },
})

/** A slow owner gets one bounded read before we return to the native snapshot. */
const OWNER_READ_DEADLINE = "2 seconds"

export const rowView = ({ child, mark, observation, at, attention }: OwnerAnswer): OwnedRow => {
  const common = {
    revision: observation.revision, sinceReload: observation.basis === "as-of-last-observation",
    at, diagnostic: observation.diagnostic?._tag === "StepError", waitingOn: "" as const,
  }
  const lifecycle = Match.value(observation.phase).pipe(Match.tagsExhaustive({
    Latched: (): Lifecycle => ({ ...common, kind: "latched" }),
    Running: (): Lifecycle => {
      if (attention) return { ...common, kind: "blocked", waitingOn: attention }
      return { ...common, kind: "running" }
    },
    Recovering: (): Lifecycle => ({ ...common, kind: "recovering" }),
    Continuing: ({ on }): Lifecycle => ({ ...common, kind: "continuing", waitingOn: on }),
    Unknown: ({ reason }): Lifecycle => {
      if (reason) return { ...common, kind: "undetermined" }
      return { ...common, kind: "unknown" }
    },
    Settled: ({ outcome }): Lifecycle => {
      if (outcome === "failed") return { ...common, kind: "failed" }
      if (outcome === "succeeded") return { ...common, kind: "done" }
      return { ...common, kind: "cancelled" }
    },
  }))
  if (mark._tag === "Readable") return { child, lifecycle, latch: mark.mark }
  return { child, lifecycle }
}

/** One read of the owner's rows for up to 512 children. */
export type ReadRows<E> = (children: ReadonlyArray<string>) => Effect.Effect<RowsReply, E>

/**
 * How a family's children follow the owner's answers: read them now and again
 * on each event that may change them, and publish each whole answer. An owner
 * notification establishes the RPC's presence, not a row's phase.
 */
export const followOwner = <E>(readOwner: ReadRows<E>): FollowRows => (reads, children, publish) => {
    const abort = new AbortController()
    const groups = Array.from({ length: Math.ceil(children.length / 512) }, (_, index) => children.slice(index * 512, (index + 1) * 512))
    let reading = false
    let dirty = false
    const revisions = new Map<string, number>()
    const revisionOf = (child: string) => Option.getOrElse(Option.fromUndefinedOr(revisions.get(child)), () => 0)
    // The answer shown, by child. A refetch replaces it only with a whole new
    // one: nothing is painted while it is in flight, so a reconnect or a burst
    // of host work never draws every child of a long root (most finished weeks
    // ago) in between, nor drops a live one.
    const shown = new Map<string, OwnedRow>()
    const refresh = () => {
      if (abort.signal.aborted) return
      if (reading) {
        dirty = true
        return
      }
      reading = true
      Effect.forEach(groups, (group) => readOwner(group), { concurrency: 2 }).pipe(
        Effect.timeout(OWNER_READ_DEADLINE),
        Effect.option,
        Effect.tap((result) => Effect.sync(() => {
            if (abort.signal.aborted) return
            if (Option.isNone(result)) {
              shown.clear()
              publish([])
              return
            }
            // An answer read while newer events arrived is still newer than the
            // one shown; the coalesced read that follows (`dirty`) replaces it in
            // turn. A child it answers below the revision a notification named
            // keeps the answer shown, else reads unknown.
            const received = new Map(result.value.flatMap((reply) =>
              Option.toArray(readRows(reply)).flatMap(({ rows }) => rows.map((row) => [row.child, row] as const))))
            const views = children.map((child) => {
              const row = received.get(child)
              const floor = revisionOf(child)
              if (!row || row.observation.child !== child) return unanswered(child, floor)
              if (row.observation.revision < floor) return shown.get(child) ?? unanswered(child, floor)
              revisions.set(child, row.observation.revision)
              return rowView(row)
            })
            views.forEach((view) => shown.set(view.child, view))
            publish(views)
        })),
        Effect.ensuring(Effect.sync(() => {
          reading = false
          if (!dirty) return
          dirty = false
          refresh()
        })),
        (read) => Effect.runFork(read, { signal: abort.signal }),
      )
    }
    const unlisten = reads.listen?.(({ details }) => {
      const changed = rowsChanged(details)
      if (Option.isSome(changed) && children.includes(changed.value.data.child)) {
        const { child, revision } = changed.value.data
        const provided = Option.fromUndefinedOr(revision)
        if (Option.isSome(provided)) {
          if (provided.value < revisionOf(child)) return
          revisions.set(child, provided.value)
        }
        refresh()
        return
      }
      if (Option.exists(metadataChanged(details), ({ data }) => children.includes(data.sessionID))
          || Option.isSome(connected(details)) || Option.isSome(hostWork(details))) refresh()
    })
    refresh()
    return () => {
      abort.abort()
      unlisten?.()
    }
}

/** The family reader over the owner's answers, one per host data. */
export const ownerRows = (context: {
  readonly data: object
  readonly client: RowsClient
  readonly location: Plugin.Context["location"]
}): FamilyReader => {
  const existing = readers.get(context.data)
  if (existing) return existing
  const reader = readerWithOwner(followOwner((children) => Effect.tryPromise((signal) =>
    context.client.rpc(CHILD_ROWS).read({ children }, { location: context.location, signal }),
  )))
  readers.set(context.data, reader)
  return reader
}

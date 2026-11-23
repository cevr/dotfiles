import type { Plugin } from "@opencode/plugin/tui"
import { Effect, Match, Option, Schema } from "effect"
import { CHILD_ROWS, readRows, rowsChanged, type OwnerAnswer, type RowsReply } from "../../kernel/opencode/child-row.ts"
import { readerWithOwner, type FamilyReader } from "./reader.ts"
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

const checking = (child: string, revision: number): OwnedRow => ({
  child, lifecycle: { kind: "checking", revision, at: 0, sinceReload: false, waitingOn: "", diagnostic: false },
})

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

/** RPC results, not host events, are the row's evidence. A notification only invalidates the read. */
export const ownerRows = (context: {
  readonly data: object
  readonly client: RowsClient
  readonly location: Plugin.Context["location"]
}): FamilyReader => {
  const existing = readers.get(context.data)
  if (existing) return existing
  const reader = readerWithOwner((reads, children, publish) => {
    const abort = new AbortController()
    const groups = Array.from({ length: Math.ceil(children.length / 512) }, (_, index) => children.slice(index * 512, (index + 1) * 512))
    let reading = false
    let dirty = false
    let generation = 0
    const revisions = new Map<string, number>()
    const revisionOf = (child: string) => Option.getOrElse(Option.fromUndefinedOr(revisions.get(child)), () => 0)
    const invalidate = () => {
      generation++
      publish(children.map((child) => checking(child, revisionOf(child))))
      refresh()
    }
    const refresh = () => {
      if (abort.signal.aborted) return
      if (reading) {
        dirty = true
        return
      }
      reading = true
      const requested = generation
      Effect.forEach(groups, (children) => Effect.tryPromise(() =>
        context.client.rpc(CHILD_ROWS).read({ children }, { location: context.location, signal: abort.signal }),
      ), { concurrency: 2 }).pipe(
        Effect.option,
        Effect.map(Option.map((answers) => answers.map((answer) => readRows(answer)))),
        Effect.tap(Option.match({
          onNone: () => Effect.void,
          onSome: (answers) => Effect.sync(() => {
            if (abort.signal.aborted || generation !== requested || !answers.every(Option.isSome)) return
            const received = new Map(answers.flatMap((answer) => answer.value.rows.map((row) => [row.child, row] as const)))
            const views = children.map((child) => {
              const row = received.get(child)
              const floor = revisionOf(child)
              if (!row || row.observation.child !== child || row.observation.revision < floor) return checking(child, floor)
              revisions.set(child, row.observation.revision)
              return rowView(row)
            })
            publish(views)
          }),
        })),
        Effect.ensuring(Effect.sync(() => {
          reading = false
          if (!dirty) return
          dirty = false
          refresh()
        })),
        Effect.runFork,
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
        invalidate()
        return
      }
      if (Option.exists(metadataChanged(details), ({ data }) => children.includes(data.sessionID))
          || Option.isSome(connected(details)) || Option.isSome(hostWork(details))) invalidate()
    })
    invalidate()
    return () => {
      abort.abort()
      unlisten?.()
    }
  })
  readers.set(context.data, reader)
  return reader
}

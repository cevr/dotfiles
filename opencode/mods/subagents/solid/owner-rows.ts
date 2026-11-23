import type { Plugin } from "@opencode/plugin/tui"
import { Effect, Match, Option, Schema } from "effect"
import { CHILD_ROWS, readRows, rowsChanged } from "../../kernel/opencode/child-row.ts"
import type { RowFact } from "../../kernel/child-row.ts"
import type { MarkRead } from "../../wake/latch.ts"
import { readerWithOwner, type FamilyReader } from "./reader.ts"
import type { Execution, OwnedRow } from "../family.ts"

const metadataChanged = Schema.decodeUnknownOption(Schema.Struct({
  type: Schema.Literal("session.metadata.updated"),
  data: Schema.Struct({ sessionID: Schema.String }),
}))
const connected = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("server.connected") }))
const readers = new WeakMap<object, FamilyReader>()

export const rowView = ({ child, mark, fact }: { readonly child: string; readonly mark: MarkRead; readonly fact: RowFact }): OwnedRow => {
  const execution = Match.value(fact).pipe(Match.tagsExhaustive({
    NoFact: (): Execution => ({ kind: "none" }),
    Failed: ({ at }): Execution => ({ kind: "failed", at }),
    ShellResultUndetermined: ({ at }): Execution => ({ kind: "undetermined", at }),
  }))
  if (mark._tag === "Readable") return { child, execution, latch: mark.mark }
  return { child, execution }
}

/** RPC results, not host events, are the row's evidence. A notification only invalidates the read. */
export const ownerRows = (context: {
  readonly data: object
  readonly client: Pick<Plugin.Context["client"], "rpc">
  readonly location: Plugin.Context["location"]
}): FamilyReader => {
  const existing = readers.get(context.data)
  if (existing) return existing
  const reader = readerWithOwner((reads, children, publish) => {
    const abort = new AbortController()
    const groups = Array.from({ length: Math.ceil(children.length / 512) }, (_, index) => children.slice(index * 512, (index + 1) * 512))
    let reading = false
    let dirty = false
    const refresh = () => {
      if (abort.signal.aborted) return
      if (reading) {
        dirty = true
        return
      }
      reading = true
      Effect.forEach(groups, (children) => Effect.tryPromise(() =>
        context.client.rpc(CHILD_ROWS).read({ children }, { location: context.location, signal: abort.signal }),
      ), { concurrency: 2 }).pipe(
        Effect.option,
        Effect.map(Option.map((answers) => answers.map((answer) => readRows(answer)))),
        Effect.tap(Option.match({
          onNone: () => Effect.void,
          onSome: (answers) => Effect.sync(() => {
            if (!abort.signal.aborted && answers.every(Option.isSome)) publish(answers.flatMap((answer) => answer.value.rows.map(rowView)))
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
      if (Option.exists(rowsChanged(details), ({ data }) => children.includes(data.child))
          || Option.exists(metadataChanged(details), ({ data }) => children.includes(data.sessionID))
          || Option.isSome(connected(details))) refresh()
    })
    refresh()
    return () => {
      abort.abort()
      unlisten?.()
    }
  })
  readers.set(context.data, reader)
  return reader
}

// The commitment record held in memory, for the plugin's seam tests and the laws: the same decisions and fold as the
// SQLite store (record.ts, standing.ts), its events in a list and its rows in a reference, one command at a time.
import { Effect, Layer, Ref, Result } from "effect"
import { SecureRandom } from "effect/crypto"
import { filingMac } from "../node/platform.ts"
import { contextForFiling, EMPTY, fold, type RecordEvent, replayFiling, type Snapshot, type StoredEvent } from "../record.ts"
import { CommitmentRecord } from "../service.ts"
import { decideCommand } from "../standing.ts"

interface Held {
  readonly key: Uint8Array
  readonly snapshot: Snapshot
  readonly events: ReadonlyArray<StoredEvent>
}

const stored = (held: Held, events: ReadonlyArray<RecordEvent>): ReadonlyArray<StoredEvent> => events.map((event, at) => ({ ...event, seq: held.events.length + at + 1 }))

/** A store over `ref`, which a test may share between two stores (two servers on one file). */
export const make = (ref: Ref.Ref<Held>): CommitmentRecord["Service"] =>
  CommitmentRecord.of({
    run: Effect.fn("CommitmentRecord.run")(function* (command, context) {
      const held = yield* Ref.get(ref)
      const events = yield* Result.match(decideCommand(held.snapshot, command, contextForFiling(context, command, filingMac(held.key))), { onFailure: Effect.fail, onSuccess: Effect.succeed })
      const snapshot = fold(held.snapshot, events)
      yield* Ref.set(ref, { key: held.key, snapshot, events: [...held.events, ...stored(held, events)] })
      return { events, snapshot }
    }),
    replayed: (command, context) => Effect.flatMap(Ref.get(ref), (held) =>
      Result.match(replayFiling(held.snapshot.filings, command, contextForFiling(context, command, filingMac(held.key))), { onFailure: Effect.fail, onSuccess: Effect.succeed })),
    read: Effect.map(Ref.get(ref), (held) => held.snapshot),
    history: (subjectKind, subjectId) => Effect.map(Ref.get(ref), (held) => held.events.filter((event) => event.subjectKind === subjectKind && event.subjectId === subjectId)),
    events: Effect.map(Ref.get(ref), (held) => held.events),
  })

/** An empty record's state, to share between stores. */
export const empty = Effect.sync(() => SecureRandom.randomBytesUnsafe(32)).pipe(Effect.flatMap((key) => Ref.make<Held>({ key, snapshot: EMPTY, events: [] })))

/** A store of its own, empty. */
export const layer = Layer.effect(CommitmentRecord, Effect.map(empty, make))

/** A store over a state some other store shares. */
export const layerOn = (ref: Ref.Ref<Held>) => Layer.succeed(CommitmentRecord, make(ref))

export type { Held }

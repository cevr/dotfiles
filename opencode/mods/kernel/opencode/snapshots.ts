// Each session's stored bindings, in the plugin's storage under
// `kernel:<sessionID>` as `{ bindings: [{ name, value }] }`: the shape every
// earlier version wrote, so stored sessions keep restoring. A value is the
// worker codec's encoding (worker/codec.ts), stored as it came.
import { Effect, Layer, Option, Schema } from "effect"
import { SnapshotBinding, type Json } from "../kernel/frame.ts"
import { Snapshots } from "../kernel/service.ts"

export const STORAGE_PREFIX = "kernel:"

/** What one session's entry holds. */
export const Stored = Schema.Struct({ bindings: Schema.Array(SnapshotBinding) })
export interface Stored extends Schema.Schema.Type<typeof Stored> {}

/** The plugin's storage, as the kernel uses it. The host's storage does not fail; a read that breaks counts as empty. */
export interface Store {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

const decodeStored = Schema.decodeUnknownOption(Stored)

export const layer = (store: Store) =>
  Layer.succeed(
    Snapshots,
    Snapshots.of({
      load: (session) =>
        store.get(STORAGE_PREFIX + session).pipe(
          Effect.map((value) => Option.match(decodeStored(value), { onNone: () => [], onSome: (stored) => stored.bindings })),
          // An entry that cannot be read, or holds something else, holds no bindings: the kernel starts empty.
          Effect.catchCause(() => Effect.succeed([])),
          Effect.withSpan("Snapshots.load"),
        ),
      save: (session, bindings) =>
        store
          .set(STORAGE_PREFIX + session, { bindings: bindings.map(({ name, value }) => ({ name, value })) })
          .pipe(Effect.withSpan("Snapshots.save")),
      drop: (session) => store.remove(STORAGE_PREFIX + session).pipe(Effect.withSpan("Snapshots.drop")),
    }),
  )

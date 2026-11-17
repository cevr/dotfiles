// Each session's kept reply-style section in the plugin's storage, under
// `reply-style:<sessionID>` as `{ text }` (the pattern of the kernel's frozen
// descriptions, mods/kernel/frozen.ts). An entry read or written is kept in
// memory too, so a session's requests read storage once. The host's storage
// does not fail; an entry that does not decode counts as none.
import { Effect, Layer, Option, Schema, Semaphore } from "effect"
import { PREFIX, ReplyStyles } from "../reply-style.ts"

/** One session's entry. */
export const Entry = Schema.Struct({ text: Schema.String })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

/** The plugin's storage, as the kept sections use it. */
export interface Store {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: { readonly text: string }) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

const decodeEntry = Schema.decodeUnknownOption(Entry)

export const make = (store: Store) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const known = new Map<string, string>()

    const read = (sessionID: string): Effect.Effect<Option.Option<string>> => {
      const cached = Option.fromNullishOr(known.get(sessionID))
      if (Option.isSome(cached)) return Effect.succeed(cached)
      return store.get(PREFIX + sessionID).pipe(
        Effect.map((value) => Option.map(decodeEntry(value), (entry) => entry.text)),
        Effect.catchCause(() => Effect.succeed(Option.none<string>())),
        Effect.tap((found) => Effect.sync(() => Option.map(found, (text) => known.set(sessionID, text)))),
      )
    }

    return ReplyStyles.of({
      kept: read,
      keep: (sessionID, text) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const kept = yield* read(sessionID)
            if (Option.isSome(kept)) return kept.value
            known.set(sessionID, text)
            yield* store.set(PREFIX + sessionID, { text })
            return text
          }),
        ),
      forget: (sessionID) => Effect.sync(() => void known.delete(sessionID)).pipe(Effect.andThen(store.remove(PREFIX + sessionID))),
    })
  })

export const layer = (store: Store) => Layer.effect(ReplyStyles, make(store))

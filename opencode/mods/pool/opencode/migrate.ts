// The plugin's storage rewritten once at start so it names store logins by
// their current credential id (legacy-ids.ts): each entry whose key or value
// names a legacy id is written again under the renamed key with the renamed
// value, and its old key removed. An entry the renamed key already holds (a
// newer pool wrote it) wins; the old one is only removed. A storage that
// cannot be read or written is left as it is: the pool starts all the same.
// A migration that finished leaves MIGRATED, so later starts skip it.
import { Effect, Option, Schema } from "effect"
import { renameText, renameValue } from "../legacy-ids.ts"
import { PAGE, type Storage } from "./ledger.ts"

type Entry = { readonly key: string; readonly value: unknown }

const asJson = Schema.decodeUnknownOption(Schema.Json)

/** Every entry of `storage` from the page after `after` on. */
const scanFrom = (storage: Storage, after: Option.Option<string>): Effect.Effect<ReadonlyArray<Entry>, unknown> =>
  storage
    .scan(Option.match(after, { onNone: () => ({ prefix: "", limit: PAGE }), onSome: (key) => ({ prefix: "", after: key, limit: PAGE }) }))
    .pipe(
      Effect.flatMap((page) =>
        Option.match(Option.fromNullishOr(page.next), {
          onNone: () => Effect.succeed(page.entries),
          onSome: (next) => scanFrom(storage, Option.some(next)).pipe(Effect.map((rest) => [...page.entries, ...rest])),
        }),
      ),
    )

/**
 * The key a finished migration leaves: a pool that finds it starts without reading its whole storage again (a
 * week of priced steps is ~190k entries, a ~30 s scan at the workbox's load, on every start of every location).
 */
export const MIGRATED = "migrated/legacy-ids"

const migrated = (storage: Storage) =>
  storage.scan({ prefix: MIGRATED, limit: 1 }).pipe(Effect.map((page) => page.entries.some((entry) => entry.key === MIGRATED)))

/** Rewrite every legacy credential id in `storage`, once; how many entries it rewrote. */
export const migrate = (storage: Storage): Effect.Effect<number> =>
  Effect.gen(function* () {
    if (yield* migrated(storage)) return 0
    const entries = yield* scanFrom(storage, Option.none())
    const keys = new Set(entries.map((entry) => entry.key))
    let rewritten = 0
    for (const { key, value } of entries) {
      const json = asJson(value)
      if (Option.isNone(json)) continue
      const renamed = renameText(key)
      const next = renameValue(json.value)
      if (renamed === key && next === json.value) continue
      if (renamed === key || !keys.has(renamed)) yield* storage.set(renamed, next)
      if (renamed !== key) yield* storage.remove(key)
      rewritten++
    }
    yield* storage.set(MIGRATED, true)
    return rewritten
  }).pipe(Effect.catchCause(() => Effect.succeed(0)))

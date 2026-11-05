// The entries and notices in the plugin's storage: `wake:<id>` and
// `notice:<delivery>`. `layer` reads them through a plain view of the storage,
// so the laws run it over a stand-in; `fromContext` takes the view from the
// plugin context.
//
// Where it lives, in the fork: `ctx.storage` (packages/plugin/src/effect/storage.ts)
// is the global database's key-value table under a namespace made from the
// plugin id (packages/core/src/plugin/host.ts `storage`), so the entries
// outlive a restart and every directory's server reads the same ones; each
// entry names its directory, and only that directory's server arms it. Its
// get, set, remove and scan never fail; `scan` pages by `next`.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Option, Schema } from "effect"
import { WakeStore } from "../service.ts"
import { Entry, Notice } from "../wake.ts"

/** The plugin's storage, as the plugin context provides it. */
export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{ readonly entries: ReadonlyArray<{ readonly key: string; readonly value?: unknown }>; readonly next?: string }>
}

export const ENTRY = "wake:"
export const NOTICE = "notice:"
/** How many keys one scan asks for. */
export const PAGE = 200

const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeNotice = Schema.decodeUnknownOption(Notice)
const encodeEntry = Schema.encodeSync(Schema.toCodecJson(Entry))
const encodeNotice = Schema.encodeSync(Schema.toCodecJson(Notice))

export const layer = (storage: Storage) => {
  /** Every key under `prefix`. */
  const keys = (prefix: string) =>
    Effect.gen(function* () {
      const found: Array<string> = []
      let after: string | undefined
      do {
        const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
        for (const entry of page.entries) found.push(entry.key)
        after = page.next
      } while (after !== undefined)
      return found
    })
  const read = (id: string) => storage.get(`${ENTRY}${id}`).pipe(Effect.map((value) => Option.getOrUndefined(decodeEntry(value))))
  return Layer.succeed(WakeStore, {
    ids: keys(ENTRY).pipe(Effect.map((found) => found.map((key) => key.slice(ENTRY.length)))),
    entries: keys(ENTRY).pipe(
      Effect.flatMap((found) => Effect.forEach(found, (key) => read(key.slice(ENTRY.length)))),
      Effect.map((entries) => entries.filter((entry) => entry !== undefined)),
    ),
    read,
    write: (entry) => storage.set(`${ENTRY}${entry.id}`, encodeEntry(entry)),
    remove: (id) => storage.remove(`${ENTRY}${id}`),
    notices: keys(NOTICE).pipe(
      Effect.flatMap((found) => Effect.forEach(found, (key) => storage.get(key).pipe(Effect.map((value) => Option.getOrUndefined(decodeNotice(value)))))),
      Effect.map((notices) => notices.filter((notice) => notice !== undefined)),
    ),
    writeNotice: (notice) => storage.set(`${NOTICE}${notice.delivery}`, encodeNotice(notice)),
    removeNotice: (delivery) => storage.remove(`${NOTICE}${delivery}`),
  })
}

/** The entries in the plugin context's storage. */
export const fromContext = (ctx: Plugin.Context) => layer(ctx.storage)

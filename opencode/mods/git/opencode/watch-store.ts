// The watches and followed repositories in the plugin's storage:
// `watch:<session>:<owner/name#n>` and `repo:<owner/name>`. `layer` reads them
// through a plain view of the storage, so the tests run it over a stand-in;
// `fromContext` takes the view from the plugin context.
//
// Where it lives, in the fork: `ctx.storage` is the global database's
// key-value table under the plugin's namespace, so the entries outlive a
// restart and every directory's server reads the same ones. Its get, set,
// remove and scan never fail; `scan` pages by `next`. An entry that no longer
// decodes is passed over.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Option, Schema } from "effect"
import { RepoRecord } from "../branch.ts"
import { WatchStore } from "../service.ts"
import { type PrRef, refText, Watch } from "../watch.ts"

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

export const WATCH = "watch:"
export const REPO = "repo:"
const PAGE = 200

const decodeWatch = Schema.decodeUnknownOption(Watch)
const decodeRepo = Schema.decodeUnknownOption(RepoRecord)
const encodeWatch = Schema.encodeSync(Schema.toCodecJson(Watch))
const encodeRepo = Schema.encodeSync(Schema.toCodecJson(RepoRecord))

const watchKey = (sessionID: string, ref: PrRef) => `${WATCH}${sessionID}:${refText(ref)}`

export const layer = (storage: Storage) => {
  /** Every value under `prefix` that decodes. */
  const all = <A>(prefix: string, decode: (value: unknown) => Option.Option<A>) =>
    Effect.gen(function* () {
      const found: Array<A> = []
      let after: string | undefined
      do {
        const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
        for (const entry of page.entries) {
          const value = entry.value === undefined ? yield* storage.get(entry.key) : entry.value
          const decoded = decode(value)
          if (Option.isSome(decoded)) found.push(decoded.value)
        }
        after = page.next
      } while (after !== undefined)
      return found
    })
  return Layer.succeed(
    WatchStore,
    WatchStore.of({
      watches: all(WATCH, decodeWatch),
      put: (watch) => storage.set(watchKey(watch.sessionID, watch), encodeWatch(watch)),
      remove: (sessionID, ref) => storage.remove(watchKey(sessionID, ref)),
      repos: all(REPO, decodeRepo),
      putRepo: (record) => storage.set(`${REPO}${record.repo}`, encodeRepo(record)),
    }),
  )
}

/** The watches in the plugin context's storage. */
export const fromContext = (ctx: Plugin.Context) => layer(ctx.storage)

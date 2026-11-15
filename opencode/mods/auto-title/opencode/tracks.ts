// The tracks in the plugin's storage, `track:<sessionID>`. `layer` reads them
// through a plain view of the storage, so the laws run it over a stand-in;
// `fromContext` takes the view from the plugin context.
//
// Where it lives, in the fork: `ctx.storage` is the global database's
// key-value table under the plugin's namespace, so a pin outlives a restart
// and every directory's copy reads the same entries. Its reads and writes
// never fail; an absent key reads as undefined. An entry that does not
// decode, absent or written by another version, reads as none.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Schema } from "effect"
import { Track } from "../retitle.ts"
import { Tracks } from "../service.ts"

/** The plugin's storage, as much of it as the tracks use. */
export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

const PREFIX = "track:"
const decode = Schema.decodeUnknownOption(Track)
const encode = Schema.encodeSync(Schema.toCodecJson(Track))

export const layer = (storage: Storage) =>
  Layer.succeed(
    Tracks,
    Tracks.of({
      get: (sessionID) => storage.get(`${PREFIX}${sessionID}`).pipe(Effect.map(decode)),
      put: (sessionID, track) => storage.set(`${PREFIX}${sessionID}`, encode(track)),
      remove: (sessionID) => storage.remove(`${PREFIX}${sessionID}`),
    }),
  )

/** The tracks in the plugin context's storage. */
export const fromContext = (ctx: Pick<Plugin.Context, "storage">) => layer(ctx.storage)

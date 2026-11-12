// The owed post-land steps in one JSON file beside the land logs (`<logs>/post-land-owed.json`), so a
// server restart keeps them. A write goes to a temporary file renamed over the old one, so a reader never
// sees half of one; a file that is missing or cannot be read holds nothing owed (the next land owes again).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { OwedPostLand } from "../owed.ts"
import { PostLandDebts, RiftFailed } from "../service.ts"

/** The file under the land logs that holds the owed steps. */
export const debtsFile = (logs: string): string => join(logs, "post-land-owed.json")

const Owed = Schema.fromJsonString(Schema.Array(OwedPostLand))
const decode = Schema.decodeUnknownOption(Owed)
const encode = Schema.encodeSync(Owed)

const failed = (operation: string) => (cause: unknown) => new RiftFailed({ operation, message: String(cause) })

export const layer = (file: string) =>
  Layer.succeed(
    PostLandDebts,
    PostLandDebts.of({
      read: Effect.try({
        try: () => {
          if (!existsSync(file)) return []
          return Option.getOrElse(decode(readFileSync(file, "utf8")), () => [])
        },
        catch: failed("read the owed post-land steps"),
      }),
      write: (owed) =>
        Effect.try({
          try: () => {
            mkdirSync(dirname(file), { recursive: true })
            const next = `${file}.next`
            writeFileSync(next, encode(owed))
            renameSync(next, file)
          },
          catch: failed("write the owed post-land steps"),
        }),
    }),
  )

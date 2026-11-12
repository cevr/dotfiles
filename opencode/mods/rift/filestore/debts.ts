// The owed post-land steps, with the newest load reading at or past the cores, in one JSON file beside the
// land logs (`<logs>/post-land-owed.json`), so a server restart keeps them. A write goes to a temporary file
// renamed over the old one, so a reader never sees half of one; a file that is missing or cannot be read
// holds nothing owed (the next land owes again). The first version's file, the owed steps alone as an
// array, reads as those steps with no loaded reading.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { Debts, noDebts, OwedPostLand } from "../owed.ts"
import { PostLandDebts, RiftFailed } from "../service.ts"

/** The file under the land logs that holds the owed steps. */
export const debtsFile = (logs: string): string => join(logs, "post-land-owed.json")

const Stored = Schema.fromJsonString(Debts)
const decode = Schema.decodeUnknownOption(Stored)
const decodeFirst = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(OwedPostLand)))
const encode = Schema.encodeSync(Stored)

/** What the file's text holds: the current form, else the first version's, else nothing. */
const parse = (text: string): Debts =>
  Option.getOrElse(
    Option.orElse(decode(text), () => Option.map(decodeFirst(text), (owed): Debts => ({ owed, loadedAt: Option.none() }))),
    () => noDebts,
  )

const failed = (operation: string) => (cause: unknown) => new RiftFailed({ operation, message: String(cause) })

export const layer = (file: string) =>
  Layer.succeed(
    PostLandDebts,
    PostLandDebts.of({
      read: Effect.try({
        try: () => {
          if (!existsSync(file)) return noDebts
          return parse(readFileSync(file, "utf8"))
        },
        catch: failed("read the owed post-land steps"),
      }),
      write: (debts) =>
        Effect.try({
          try: () => {
            mkdirSync(dirname(file), { recursive: true })
            const next = `${file}.next`
            writeFileSync(next, encode(debts))
            renameSync(next, file)
          },
          catch: failed("write the owed post-land steps"),
        }),
    }),
  )

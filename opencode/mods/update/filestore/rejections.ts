import { Effect, Layer, Option, Schema } from "effect"
import { Rejections } from "../service.ts"
import { Rejected } from "../update.ts"
import { readText, writeText } from "./files.ts"

const RejectedJson = Schema.fromJsonString(Rejected, { space: 2 })
const decode = Schema.decodeUnknownOption(RejectedJson)
const encode = Schema.encodeSync(RejectedJson)

/** The rejected target in its file, `<update state>/rejected.json`; a lost write is logged by the caller's next try. */
export const layer = (path: string) =>
  Layer.succeed(
    Rejections,
    Rejections.of({
      read: readText(path).pipe(Effect.map((text) => Option.flatMap(text, decode))),
      write: (rejected) => writeText("write the rejected target", path, `${encode(rejected)}\n`).pipe(Effect.ignore),
    }),
  )

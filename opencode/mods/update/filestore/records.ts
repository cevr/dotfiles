import { Effect, Layer, Option } from "effect"
import { parseRecord, recordText } from "../record.ts"
import { Records } from "../service.ts"
import { readText, writeText } from "./files.ts"

/** The installed record in its file, `<XDG state>/opencode/installed.json`. */
export const layer = (path: string) =>
  Layer.succeed(
    Records,
    Records.of({
      read: readText(path).pipe(Effect.map((text) => Option.flatMap(text, parseRecord))),
      write: (record) => writeText("write the installed record", path, recordText(record)),
    }),
  )

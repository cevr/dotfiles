import { Clock, Effect, Layer, Option } from "effect"
import { Heartbeat } from "../service.ts"
import { readText, writeText } from "./files.ts"

/** The stamp's text as an instant (epoch ms); none for text that is not one. */
export const stampOf = (text: string): Option.Option<number> => Option.liftPredicate(Number(text.trim()), (at) => Number.isSafeInteger(at) && at > 0)

/** The last check's stamp in its file, `<update state>/checked`: the epoch ms of the check. */
export const layer = (path: string) =>
  Layer.succeed(
    Heartbeat,
    Heartbeat.of({
      beat: Clock.currentTimeMillis.pipe(Effect.flatMap((at) => writeText("stamp the check", path, `${at}\n`)), Effect.ignore),
      last: readText(path).pipe(Effect.map((text) => Option.flatMap(text, stampOf))),
    }),
  )

import { Clock, Effect, Layer, Option } from "effect"
import { iso } from "../gate.ts"
import { Log } from "../service.ts"
import { readText, writeText } from "./files.ts"

/** How many lines the log keeps: the newest. */
export const KEPT_LINES = 2_000

/** The log with `line` added, its oldest lines dropped past `KEPT_LINES`. */
export const appended = (text: Option.Option<string>, line: string): string => {
  const lines = Option.match(text, { onNone: () => [], onSome: (each) => each.split("\n").filter((part) => part !== "") })
  return `${[...lines, line].slice(-KEPT_LINES).join("\n")}\n`
}

/** The update's log in its file: one stamped line per step, with the host it ran on. */
export const layer = (path: string, host: string) =>
  Layer.succeed(
    Log,
    Log.of({
      line: (text) =>
        Effect.gen(function* () {
          const line = `${iso(yield* Clock.currentTimeMillis)} ${host} ${text}`
          yield* writeText("write the update log", path, appended(yield* readText(path), line))
        }).pipe(Effect.orElseSucceed(() => "unlogged"), Effect.asVoid),
    }),
  )

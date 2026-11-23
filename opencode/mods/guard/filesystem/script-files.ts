// ScriptFiles over the filesystem, with Bun's file reader: a script's text, or
// none when it is missing, unreadable (a directory, no permission) or larger
// than `MAX_BYTES`, which no hand-written probe is.
import { file } from "bun"
import { Effect, Layer, Option } from "effect"
import { ScriptFiles } from "../service.ts"

/** The largest script the keychain rule reads: 1 MiB. */
export const MAX_BYTES = 1_048_576

export const layer = Layer.succeed(
  ScriptFiles,
  ScriptFiles.of({
    text: Effect.fn("ScriptFiles.text")(function* (path: string) {
      const handle = file(path)
      if (handle.size > MAX_BYTES) return Option.none()
      return yield* Effect.tryPromise(() => handle.text()).pipe(
        Effect.map(Option.some),
        Effect.catchTag("UnknownError", () => Effect.succeed(Option.none())),
      )
    }),
  }),
)

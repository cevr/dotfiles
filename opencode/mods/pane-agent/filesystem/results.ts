import { Duration, Effect, FileSystem, Layer, Option } from "effect"
import { ResultFiles, ResultReadFailed } from "../service.ts"

const SETTLE = Duration.millis(50)

const readFailure = (path: string, cause: { readonly message: string }) =>
  new ResultReadFailed({ path, message: cause.message })

/** Reads a result file once it exists, is newer than the turn start, is non-empty, and is stable across a brief settle. */
export const layer = Layer.effect(
  ResultFiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const readComplete = Effect.fn("FsResultFiles.readComplete")(function* (path: string, minMtimeMs: number) {
      const exists = yield* fs.exists(path).pipe(Effect.mapError((cause) => readFailure(path, cause)))
      if (!exists) return Option.none<string>()
      const info1 = yield* fs.stat(path).pipe(Effect.mapError((cause) => readFailure(path, cause)))
      const mtime1 = Option.map(info1.mtime, (date) => date.getTime())
      if (Option.isSome(mtime1) && mtime1.value < minMtimeMs) return Option.none<string>()
      const text1 = yield* fs.readFileString(path).pipe(Effect.mapError((cause) => readFailure(path, cause)))
      if (text1.trim().length === 0) return Option.none<string>()
      yield* Effect.sleep(SETTLE)
      const text2 = yield* fs.readFileString(path).pipe(Effect.mapError((cause) => readFailure(path, cause)))
      if (text2 !== text1) return Option.none<string>()
      return Option.some(text2.trim())
    })

    return ResultFiles.of({ readComplete })
  }),
)

import { layer } from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Path, Schema } from "effect"

const PathList = Schema.Record(Schema.NonEmptyString, Schema.Array(Schema.NonEmptyString))
const Manifest = Schema.fromJsonString(Schema.Struct({
  paths: PathList,
  untracedSubprocesses: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
  compilerProjects: PathList,
}))

export class InvalidTestReadMap extends Data.TaggedError("InvalidTestReadMap")<{ readonly message: string }> {}
export type RuntimeReads = typeof Manifest.Type
export const emptyReadMap: RuntimeReads = { paths: {}, untracedSubprocesses: {}, compilerProjects: {} }

/** Do not import JSON: malformed bytes must be reported in the same typed error as a bad shape. */
export const readMapAt = (root: string) => Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const file = path.join(root, "scripts/test-impact-observations.json")
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
    Effect.mapError((cause) => new InvalidTestReadMap({ message: `${file}: ${cause.message}` })),
  )
})

export const loadReadMap = (root: string) => readMapAt(root).pipe(Effect.provide(layer), Effect.runPromise)

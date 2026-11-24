import { cwd } from "node:process"
import { Effect, FileSystem, Path, Schema } from "effect"

class InCheckout extends Schema.TaggedError<InCheckout>()("InCheckout", { file: Schema.String }) {}

/** A generated Drive artifact must resolve outside the checkout from which Drive runs. */
export const externalScenarioInput = Effect.fn("Drive.externalArtifact")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const checkout = yield* fs.realPath(path.resolve(cwd(), ".."))
  const target = yield* fs.realPath(file)
  const rest = path.relative(checkout, target)
  if (!(rest === ".." || rest.startsWith("../") || path.isAbsolute(rest))) return yield* new InCheckout({ file })
  return target
})

// compact.json, read on every ask, so a reload picks up the tuner's rewrite.
import { readFileSync } from "node:fs"
import { Effect, Layer, Option } from "effect"
import { windowsOf } from "../compaction.ts"
import { CompactionWindows } from "../service.ts"

export const layer = (file: string) =>
  Layer.succeed(CompactionWindows, {
    read: Effect.try(() => readFileSync(file, "utf8")).pipe(
      Effect.option,
      Effect.map((text) => windowsOf(Option.getOrUndefined(text))),
    ),
  })

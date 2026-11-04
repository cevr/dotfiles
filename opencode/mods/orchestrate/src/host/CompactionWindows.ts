// compact.json, read on every ask, so a reload picks up the tuner's rewrite.
import { readFileSync } from "node:fs"
import { Effect, Layer, Option } from "effect"
import { windowsOf, type Windows } from "../domain/Compaction.ts"
import { CompactionWindows } from "../domain/Agents/CompactionWindows.external.ts"

export const layer = (file: string) =>
  Layer.succeed(CompactionWindows, {
    read: Effect.try(() => readFileSync(file, "utf8")).pipe(
      Effect.option,
      Effect.map((text) => windowsOf(Option.getOrUndefined(text))),
    ),
  })

/** compact.json's text, or none; the same parsing as the file's. */
export const layerTest = (text: string | undefined) =>
  Layer.succeed(CompactionWindows, { read: Effect.sync((): Windows => windowsOf(text)) })

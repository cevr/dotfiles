// compact.json held in memory: its text, or none, read with the same parsing
// as the file's (compaction.ts).
import { Effect, Layer } from "effect"
import { windowsOf, type Windows } from "../compaction.ts"
import { CompactionWindows } from "../service.ts"

/** compact.json's text, or none. */
export const layer = (text: string | undefined) =>
  Layer.succeed(CompactionWindows, { read: Effect.sync((): Windows => windowsOf(text)) })

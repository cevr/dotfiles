// The call log as a JSONL file. A line that cannot be written is dropped:
// the log serves the status pane, never the call.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import type { CallLine } from "../domain/CallLine.ts"
import { CallLog } from "../domain/ToolCall/CallLog.external.ts"

export const layer = (file: string) =>
  Layer.succeed(CallLog, {
    append: Effect.fn("CallLog.append")(function* (line: CallLine) {
      yield* Effect.try(() => {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(line)}\n`)
      }).pipe(Effect.ignore)
    }),
  })

/** Lines appended to `lines`, in order. */
export const layerTest = (lines: Array<CallLine>) =>
  Layer.succeed(CallLog, { append: (line: CallLine) => Effect.sync(() => void lines.push(line)) })

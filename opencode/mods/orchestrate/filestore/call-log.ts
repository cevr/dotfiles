// The call log as a JSONL file. A line that cannot be written is dropped:
// the log serves the status pane, never the call.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import type { CallLine } from "../call-line.ts"
import { CallLog } from "../service.ts"

export const layer = (file: string) =>
  Layer.succeed(CallLog, {
    append: Effect.fn("CallLog.append")(function* (line: CallLine) {
      yield* Effect.try(() => {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(line)}\n`)
      }).pipe(Effect.ignore)
    }),
  })

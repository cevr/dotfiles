// The call log as a JSONL file. A line that cannot be written is dropped:
// the log serves the status pane, never the call. `read` gives the log whole,
// for the heavy agents' count (heavy-agents.ts).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import type { CallLine } from "../call-line.ts"
import { CallLog, HostUnread } from "../service.ts"

export const layer = (file: string) =>
  Layer.succeed(CallLog, {
    append: Effect.fn("CallLog.append")(function* (line: CallLine) {
      yield* Effect.try(() => {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(line)}\n`)
      }).pipe(Effect.ignore)
    }),
  })

/** The text of the call log at `file`: none yet is empty; one that is there and cannot be read is `HostUnread`. */
export const read = (file: string): Effect.Effect<string, HostUnread> =>
  Effect.try({
    try: () => {
      if (!existsSync(file)) return ""
      return readFileSync(file, "utf8")
    },
    catch: (cause) => new HostUnread({ reason: `the call log ${file} does not read: ${String(cause)}` }),
  })

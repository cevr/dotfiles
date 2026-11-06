// The steps a session started, read from the call log the CallLog layer
// writes (call-line.ts): its `call` and `latched` lines whose description
// names a step (described.ts), by the unit each names. The log is read whole
// on each ask; it grows by a line or two per subagent. No file is no steps; a
// line that does not read (a partial last line, another program's) is
// skipped.
import { readFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { described } from "../described.ts"
import { unitOf } from "../idle.ts"
import { StepLog } from "../service.ts"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The unit each line of `text` that `sessionID` started a step with names, once each, in order. */
export const unitsIn = (text: string, sessionID: string): ReadonlyArray<string> => {
  const units = new Set<string>()
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue
    let line: unknown
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isRecord(line) || line.sessionID !== sessionID || (line.kind !== "call" && line.kind !== "latched")) continue
    const step = described(typeof line.description === "string" ? line.description : undefined)
    const unit = step === undefined ? undefined : unitOf(step.rest)
    if (unit !== undefined) units.add(unit)
  }
  return [...units]
}

export const layer = (file: string) =>
  Layer.succeed(StepLog, {
    units: Effect.fn("StepLog.units")(function* (sessionID: string) {
      const text = yield* Effect.tryPromise(() => readFile(file, "utf8")).pipe(Effect.orElseSucceed(() => ""))
      return unitsIn(text, sessionID)
    }),
  })

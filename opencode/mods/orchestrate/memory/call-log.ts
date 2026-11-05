// The call log held in memory: each appended line, in order, in an array the
// plugin's seam tests read.
import { Effect, Layer } from "effect"
import type { CallLine } from "../call-line.ts"
import { CallLog } from "../service.ts"

/** Lines appended to `lines`, in order. */
export const layer = (lines: Array<CallLine>) =>
  Layer.succeed(CallLog, { append: (line: CallLine) => Effect.sync(() => void lines.push(line)) })

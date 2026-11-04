import { Effect } from "effect"
import type { CallLine } from "../call-line.ts"
import { callLogLaws } from "../laws.ts"
import * as MemoryCallLog from "./call-log.ts"

callLogLaws(
  "memory CallLog",
  Effect.sync(() => {
    const lines: Array<CallLine> = []
    return { layer: MemoryCallLog.layer(lines), written: Effect.sync(() => [...lines]) }
  }),
)

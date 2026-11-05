import { Effect } from "effect"
import { callLogLaws } from "../laws.ts"
import * as MemoryCallLog from "./call-log.ts"

callLogLaws(
  "memory CallLog",
  Effect.sync(() => {
    const log: MemoryCallLog.MemoryLog = { events: [] }
    return {
      layer: MemoryCallLog.layer(log),
      record: (events) => Effect.sync(() => void log.events.push(...events)),
      spoil: Effect.sync(() => {
        log.failure = "EACCES: permission denied"
      }),
    }
  }),
)

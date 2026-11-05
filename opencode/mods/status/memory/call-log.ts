// The call log held in memory: the events it records, or the reason it cannot
// be read, read again on every call. The plugin's seam tests change it.
import { Effect, Layer } from "effect"
import type { Event } from "../agent-calls.ts"
import { CallLog, CallLogUnreadable } from "../service.ts"

/** The log: its events in order (none: no log yet), or why it cannot be read. */
export interface MemoryLog {
  readonly events: Array<Event>
  failure?: string
}

export const layer = (log: MemoryLog) =>
  Layer.succeed(CallLog, {
    events: Effect.suspend(() =>
      log.failure === undefined
        ? Effect.succeed([...log.events])
        : Effect.fail(new CallLogUnreadable({ message: log.failure })),
    ),
  })

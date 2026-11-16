// The step log held in memory: the units each session started steps of, as
// a record the plugin's seam tests set; and each session's calls, none
// unless the test sets them.
import { Effect, Layer, Option } from "effect"
import { type Calls, NO_CALLS } from "../ledger.ts"
import { StepLog } from "../service.ts"

/** Each session's units, in the order it started them; any other session started none. */
export const layer = (units: Readonly<Record<string, ReadonlyArray<string>>>, calls: ReadonlyMap<string, Calls> = new Map()) =>
  Layer.succeed(StepLog, {
    units: (sessionID: string) => Effect.succeed(Object.hasOwn(units, sessionID) ? [...new Set(units[sessionID])] : []),
    calls: (sessionID: string) => Effect.succeed(Option.getOrElse(Option.fromUndefinedOr(calls.get(sessionID)), () => NO_CALLS)),
  })

// The step log held in memory: the units each session started steps of, as
// a record the plugin's seam tests set.
import { Effect, Layer } from "effect"
import { StepLog } from "../service.ts"

/** Each session's units, in the order it started them; any other session started none. */
export const layer = (units: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Layer.succeed(StepLog, { units: (sessionID: string) => Effect.succeed(Object.hasOwn(units, sessionID) ? [...new Set(units[sessionID])] : []) })

// Quota readings as the quota protocol's `reading` event: published through
// the plugin's RPC registration once it exists, and never waited on.
import { Effect, Layer } from "effect"
import type { QuotaReading } from "../quota.ts"
import { QuotaEvents } from "../service.ts"

/** How a reading goes out: the registration's `events.emit("reading", …)`. */
export type Emit = (credentialID: string, reading: QuotaReading) => Effect.Effect<void, unknown>

/**
 * The cell the emit lives in: empty until the RPC is registered (a reading
 * before then goes nowhere, as a reading after dispose does).
 */
export interface EmitCell {
  current: Emit | undefined
}

export const makeEmitCell = (): EmitCell => ({ current: undefined })

/**
 * Readings out through `cell`: each emit starts at once on its own fiber
 * (the publisher never waits on it), and its failure is dropped.
 */
export const layer = (cell: EmitCell) =>
  Layer.succeed(QuotaEvents, {
    publish: (credentialID, reading) =>
      Effect.suspend(() => {
        const emit = cell.current
        return emit === undefined
          ? Effect.void
          : emit(credentialID, reading).pipe(Effect.ignoreCause, Effect.forkDetach({ startImmediately: true }), Effect.asVoid)
      }),
  })

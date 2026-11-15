// The owed post-land steps held in memory, for the model's tests: the same World across two tools stands for
// the file a restarted server reads again, and across tools at once for the plugin instances of one host,
// which share the post-land claim as they share the host's lock file.
import { Effect, Layer, Semaphore } from "effect"
import { noDebts, type Debts } from "../owed.ts"
import { PostLandClaim, PostLandDebts } from "../service.ts"

export interface World {
  debts: Debts
  readonly claim: Semaphore.Semaphore
  /** How many hold the claim now: 0 or 1. */
  held: number
}

export const world = (): World => ({ debts: noDebts, claim: Semaphore.makeUnsafe(1), held: 0 })

export const layer = (state: World) => {
  const holding = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => (state.held += 1)),
      () => effect,
      () => Effect.sync(() => (state.held -= 1)),
    )
  return Layer.mergeAll(
    Layer.succeed(
      PostLandDebts,
      PostLandDebts.of({
        read: Effect.sync(() => state.debts),
        update: (change) =>
          Effect.sync(() => {
            state.debts = change(state.debts)
            return state.debts
          }),
      }),
    ),
    Layer.succeed(
      PostLandClaim,
      PostLandClaim.of({
        hold: (effect) => state.claim.withPermits(1)(holding(effect)),
        holdIfFree: (effect) => state.claim.withPermitsIfAvailable(1)(holding(effect)),
      }),
    ),
  )
}

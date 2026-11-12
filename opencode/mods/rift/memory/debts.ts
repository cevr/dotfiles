// The owed post-land steps held in memory, for the model's tests: the same World across two tools stands for
// the file a restarted server reads again.
import { Effect, Layer } from "effect"
import { noDebts, type Debts } from "../owed.ts"
import { PostLandDebts } from "../service.ts"

export interface World {
  debts: Debts
}

export const world = (): World => ({ debts: noDebts })

export const layer = (state: World) =>
  Layer.succeed(
    PostLandDebts,
    PostLandDebts.of({
      read: Effect.sync(() => state.debts),
      write: (debts) =>
        Effect.sync(() => {
          state.debts = debts
        }),
    }),
  )

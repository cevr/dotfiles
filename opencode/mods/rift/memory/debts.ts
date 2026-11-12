// The owed post-land steps held in memory, for the model's tests: the same World across two tools stands for
// the file a restarted server reads again.
import { Effect, Layer } from "effect"
import type { OwedPostLand } from "../owed.ts"
import { PostLandDebts } from "../service.ts"

export interface World {
  owed: ReadonlyArray<OwedPostLand>
}

export const world = (): World => ({ owed: [] })

export const layer = (state: World) =>
  Layer.succeed(
    PostLandDebts,
    PostLandDebts.of({
      read: Effect.sync(() => state.owed),
      write: (owed) =>
        Effect.sync(() => {
          state.owed = owed
        }),
    }),
  )

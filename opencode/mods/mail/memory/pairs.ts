// A host's pairing state in memory: the double the simulated hosts use, shared
// by a host's plugin copies and its pair command as the file is
// (filestore/pairs.ts). A test may make its writes fail.
import { Effect, Layer } from "effect"
import { EMPTY, type Pairs } from "../pairing.ts"
import { PairStore, PairsUnwritable } from "../service.ts"

export const make = (initial: Pairs = EMPTY) => {
  const state = { pairs: initial, failing: false, writes: 0 }
  return {
    layer: Layer.succeed(
      PairStore,
      PairStore.of({
        read: Effect.sync(() => state.pairs),
        update: (change) =>
          Effect.suspend(() => {
            if (state.failing) return Effect.fail(new PairsUnwritable({ message: "the pairing store refused the write" }))
            const [result, next] = change(state.pairs)
            state.pairs = next
            state.writes += 1
            return Effect.succeed(result)
          }),
      }),
    ),
    /** The pairing as it stands. */
    read: () => state.pairs,
    /** Makes every write fail from now, or succeed again. */
    failWrites: (failing: boolean) => {
      state.failing = failing
    },
  }
}

export type MemoryPairs = ReturnType<typeof make>

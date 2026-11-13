// The courier's delivery ids on Effect's `Clock` and `Random`, so a seeded
// world replays them: the same seed on the same clock mints the same ids.
import { Effect, Random } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { Courier } from "../service.ts"
import { layer } from "./courier.ts"

const AT = 0x1234_5678

/** Two delivery ids from the layer on `seed`, the clock at `AT`. */
const twoIds = (seed: string) =>
  Courier.use((service) => Effect.all([service.newDelivery, service.newDelivery])).pipe(
    Effect.provide(layer({ synthetic: () => Effect.void })),
    Random.withSeed(seed),
  )

describe("the OpenCode courier's delivery ids", () => {
  it.effect("read Effect's clock and random: the same seed on the same clock gives the same ids, ascending", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const [first, second] = yield* twoIds("questions")
      expect(yield* twoIds("questions")).toEqual([first, second])
      expect(first.slice(0, 16)).toBe(`msg_${(BigInt(AT) * 0x1000n + 1n).toString(16).padStart(12, "0").slice(-12)}`)
      expect(second > first).toBe(true)
    }),
  )
})

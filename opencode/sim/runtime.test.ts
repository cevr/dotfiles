// The runtime alone: time moves only by `advance`, a timer fires once at its
// instant, same-instant timers and ready fibers take an order the seed picks,
// and a run that waits on time says so instead of hanging.
import { describe, expect } from "bun:test"
import * as Seed from "./seed.ts"
import { Duration, Effect, Exit, Fiber, Stream } from "effect"
import { makeRuntime } from "./runtime.ts"

/** 2026-01-01T00:00:00Z. */
const START = 1_767_225_600_000
const runtimeOf = (seed: number) => makeRuntime({ seed, start: START, log: () => void 0, fired: () => void 0 })

/** The order six one-second sleeps end in, on one seed. */
const timersOn = (seed: number) =>
  Effect.gen(function* () {
    const runtime = runtimeOf(seed)
    const order: Array<number> = []
    for (let index = 0; index < 6; index += 1) runtime.fork(Effect.sleep("1 second").pipe(Effect.map(() => void order.push(index))))
    yield* runtime.advance(1_000)
    return order.join(",")
  })

/** The order three fibers' steps interleave in, on one seed. */
const fibersOn = (seed: number) =>
  Effect.gen(function* () {
    const runtime = runtimeOf(seed)
    const seen: Array<string> = []
    for (const name of ["a", "b", "c"])
      runtime.fork(Stream.range(1, 4).pipe(Stream.runForEach((n) => Effect.sync(() => void seen.push(`${name}${n}`)).pipe(Effect.andThen(Effect.yieldNow)))))
    yield* runtime.settle
    return seen.join(" ")
  })

describe("the runtime", () => {
  Seed.effect(
    "a sleep ends only when the clock is advanced past it, and at its own instant",
    Effect.gen(function* () {
      const runtime = runtimeOf(1)
      const woke: Array<number> = []
      runtime.fork(
        Effect.sleep("10 seconds").pipe(
          Effect.andThen(Effect.clockWith((clock) => clock.currentTimeMillis)),
          Effect.map((at) => void woke.push(at)),
        ),
      )
      yield* runtime.advance(9_999)
      expect(woke).toEqual([])
      yield* runtime.advance(5_000)
      expect(woke).toEqual([START + 10_000])
      expect(runtime.now()).toBe(START + 14_999)
    }),
  )

  Seed.effect(
    "timers due at one instant fire in an order the seed picks, the same for the same seed",
    Effect.gen(function* () {
      const orders = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, seed) => seed),
        timersOn,
      )
      expect(yield* timersOn(3)).toBe(orders[3])
      expect(new Set(orders).size).toBeGreaterThan(5)
    }),
  )

  Seed.effect(
    "fibers interleave in an order the seed picks",
    Effect.gen(function* () {
      const orders = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, seed) => seed),
        fibersOn,
      )
      expect(new Set(orders).size).toBeGreaterThan(1)
      expect(yield* fibersOn(7)).toBe(orders[7])
    }),
  )

  Seed.effect(
    "a run that needs time fails at once, naming why, and a fiber that never ends stays unended",
    Effect.gen(function* () {
      const runtime = runtimeOf(1)
      // A timer on the world's clock: the run cannot end without an advance.
      const exit = yield* Effect.exit(runtime.run(Effect.clockWith((clock) => clock.sleep(Duration.seconds(1)))))
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("waits on time")
      const fiber = runtime.fork(Effect.never)
      yield* runtime.settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      runtime.fork(Fiber.interrupt(fiber))
      yield* runtime.settle
      expect(fiber.pollUnsafe()).toBeDefined()
    }),
  )
})

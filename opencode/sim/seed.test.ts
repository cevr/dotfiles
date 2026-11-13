// The seed runner's budget: a file whose seeds spend more CPU than its budget
// fails, saying its CPU and wall time; one whose wall time runs long while it
// spends little CPU (a loaded host's time, not the file's work) passes.
import { Effect, Exit } from "effect"
import { describe, expect } from "bun:test"
import { TestClock } from "effect/testing"
import * as Seed from "./seed.ts"

const FILE = "sim/budget-probe.sim.test.ts"

/** Spends `ms` of this process's CPU time, busy. */
const busy = (ms: number) =>
  Effect.sync(() => {
    const began = process.cpuUsage()
    let spins = 0
    for (;;) {
      const used = process.cpuUsage(began)
      if ((used.user + used.system) / 1000 >= ms) return spins
      spins += 1
    }
  })

/** What `body` on seeds 1 and 2 under `budgetMs` spent, and the message it failed with ("" when it passed). */
const run = (body: Effect.Effect<unknown>, budgetMs: number) =>
  Effect.gen(function* () {
    const spent: Seed.Spent = { cpu: 0, wall: 0 }
    const exit = yield* Effect.exit(Effect.forEach([1, 2], (seed) => Seed.once(FILE, spent, "probe", seed, () => Effect.asVoid(body), budgetMs)))
    return { spent, failed: Exit.match(exit, { onFailure: String, onSuccess: () => "" }) }
  })

describe("the seed runner's budget", () => {
  Seed.effect("a file whose seeds spend more CPU than the budget fails, naming its CPU and wall time",
    Effect.gen(function* () {
      const { spent, failed } = yield* run(busy(40), 60)
      expect(spent.cpu).toBeGreaterThan(60)
      expect(failed).toMatch(/sim\/budget-probe\.sim\.test\.ts: its seeds took \d+ ms of CPU time \(\d+ ms of wall time\), past the 60 ms of CPU a simulated file has/)
    }),
  )

  Seed.effect("a file whose wall time runs past the budget on little CPU passes",
    Effect.gen(function* () {
      // Each seed's wall time is a minute (the clock moved, as a loaded host's does), its CPU next to none.
      const { spent, failed } = yield* run(TestClock.adjust("1 minute"), 50)
      expect(failed).toBe("")
      expect(spent.wall).toBe(120_000)
      expect(spent.cpu).toBeLessThan(50)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

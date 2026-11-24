// Run by sim/seed.test.ts as its own `bun test`, never by the suite: a seeded
// test whose seeds run past its timeout, then a test that watches for any of
// them still running. Each seed waits 100 ms of wall time and says it ran.
import { expect } from "bun:test"
import { Console, Effect } from "effect"
import { simulationRunner, simulationTest } from "../seed.ts"
import { simulationBudget } from "../budget.ts"

const ran: Array<number> = []
const { seeded } = simulationRunner("sim/fixtures/seed-timeout.fixture.ts", { budget: simulationBudget(300) })

seeded("seeds that run past the timeout", ({ seed }) =>
  Effect.gen(function* () {
    yield* Effect.sleep("100 millis")
    ran.push(seed)
  }),
)

simulationTest(
  "the next test sees none of the timed-out test's seeds run",
  Effect.gen(function* () {
    const before = ran.length
    yield* Effect.sleep("500 millis")
    yield* Console.log(`seed-timeout: ${before} seeds ran before, ${ran.length - before} after`)
    expect(ran.length).toBe(before)
  }),
)

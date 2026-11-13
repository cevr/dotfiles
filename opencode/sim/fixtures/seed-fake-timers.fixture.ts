// Run by sim/seed.test.ts as its own `bun test`, never by the suite: a seeded
// test under bun's fake timers, held from the test before it as sim-tui's TUI
// files hold them from their boot, whose seeds move the virtual clock far past
// the runner's timeout in no wall time at all, timers and the clock alike.
// The timeout is wall time: every seed runs and the test passes.
import { expect, jest, test } from "bun:test"
import { Console, Effect } from "effect"
import * as Seed from "../seed.ts"

const ran: Array<number> = []
const { seeded } = Seed.runner("sim/fixtures/seed-fake-timers.fixture.ts", { timeoutMs: 1_000 })

test("the fake timers are taken", () => {
  jest.useFakeTimers()
  expect(ran).toEqual([])
})

seeded("seeds that move the virtual clock past the timeout", ({ seed }) =>
  Effect.gen(function* () {
    jest.advanceTimersByTime(60_000)
    // A turn of the process, as a TUI seed takes many: a timer fired by the advance acts here.
    yield* Effect.yieldNow
    ran.push(seed)
  }),
)

test("the fake timers are given back", () => {
  jest.useRealTimers()
  expect(ran).toHaveLength(Seed.SEEDS)
})

Seed.effect("says how many seeds ran", Effect.suspend(() => Console.log(`seed-fake-timers: ${ran.length} seeds ran`)))

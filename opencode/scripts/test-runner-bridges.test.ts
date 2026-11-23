// @reads sim/seed.ts sim-tui/effect-test.ts mods/work/laws.ts tests/hang-guard.ts
import { expect, test } from "bun:test"
import { riftsLawBudget } from "../mods/work/laws.ts"
import { tuiTestBudget } from "../sim-tui/effect-test.ts"
import * as Seed from "../sim/seed.ts"
import { hangGuard, measured, runnerCapOf } from "../tests/hang-guard.ts"

test("the simulation diagnostic owns its deadline before Bun, even with a swarm box", () => {
  for (const ms of [300, Seed.TIMEOUT_MS, Seed.TIMEOUT_MS + 57_000]) {
    const budget = Seed.simulationBudget(ms)
    expect(Seed.runnerCapOf(budget) - budget).toBe(Seed.TIMEOUT_GRACE_MS)
    expect(Seed.runnerCapOf(budget)).toBeGreaterThan(budget)
  }
})

test("the real-I/O TUI bridge's wall diagnostic is earlier than Bun", () => {
  const budget = tuiTestBudget(hangGuard("installer"))
  expect(budget.deadline).toBe(119_000)
  expect(Number(runnerCapOf(budget))).toBe(120_000)
})

test("the Rifts-law bridge lets its scoped diagnostic fire before Bun", () => {
  const budget = riftsLawBudget(hangGuard("process-fixture"))
  expect(budget.deadline).toBe(59_000)
  expect(Number(runnerCapOf(budget))).toBe(60_000)
})

test("measurement failures name the target, budget, reading and host load", () => {
  expect(() => measured("a controlled sample", "< 20 ms", ({ sample }) => sample(20))).toThrow(
    /a controlled sample: budget < 20 ms; measured 20 ms; host load/,
  )
})

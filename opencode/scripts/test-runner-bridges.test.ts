// @reads sim/seed.ts sim/budget.ts sim-tui/effect-test.ts sim-tui/bridge-hang.fixture.ts mods/work/laws.ts tests/rifts-law-hang.fixture.ts tests/hang-guard.ts tests/global-slot.ts
import { expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { it } from "effect-bun-test"
import { TIMEOUT_MS as SeedTIMEOUT_MS } from "../sim/seed.ts"
import { simulationBudget, simulationRunnerCapOf, TIMEOUT_GRACE_MS } from "../sim/budget.ts"
import { globalSlot } from "../tests/global-slot.ts"
import { bridgeBudget, hangGuard, measured, runnerCapOf } from "../tests/hang-guard.ts"
import { checkoutTests } from "../tests/scratch-child.ts"

test("the simulation diagnostic owns its deadline before Bun, even with a swarm box", () => {
  for (const ms of [300, SeedTIMEOUT_MS, SeedTIMEOUT_MS + 57_000]) {
    const budget = simulationBudget(ms)
    expect(simulationRunnerCapOf(budget) - budget).toBe(TIMEOUT_GRACE_MS)
    expect(simulationRunnerCapOf(budget)).toBeGreaterThan(budget)
  }
})

test("the real-I/O TUI bridge's wall diagnostic is earlier than Bun", () => {
  const budget = bridgeBudget(hangGuard("installer"))
  expect(budget.deadline).toBe(119_000)
  expect(Number(runnerCapOf(budget))).toBe(120_000)
})

test("the Rifts-law bridge lets its scoped diagnostic fire before Bun", () => {
  const budget = bridgeBudget(hangGuard("process-fixture"))
  expect(budget.deadline).toBe(59_000)
  expect(Number(runnerCapOf(budget))).toBe(60_000)
})

const hungBridge = Effect.fn("Timing.hungBridge")(function* (fixture: ReturnType<typeof checkoutTests>, label: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [bun = "", ...args] = fixture.argv
  const child = yield* spawner.spawn(ChildProcess.make(bun, args, { cwd: fixture.cwd, env: fixture.env, extendEnv: false, stdout: "ignore", forceKillAfter: "1 second" }))
  const errors = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString)
  expect(Number(yield* child.exitCode), errors).toBe(1)
  expect(errors).toContain(`${label}: its fixture did not complete before the 4000 ms diagnostic deadline`)
  expect(errors).not.toMatch(/timed out after/i)
})

it.scopedLive.layer(BunServices.layer)("hung TUI and Rifts bodies report their bridge deadline rather than Bun's cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tui = yield* fs.makeTempDirectoryScoped({ prefix: "tui-bridge-" })
    const rifts = yield* fs.makeTempDirectoryScoped({ prefix: "rifts-bridge-" })
    yield* Effect.all([
      hungBridge(checkoutTests({ temp: tui, state: tui, filter: "TUI bridge diagnostic witness" }, "sim-tui/bridge-hang.fixture.ts"), "TUI bridge diagnostic witness"),
      hungBridge(checkoutTests({ temp: rifts, state: rifts, filter: "a created Rift is listed under its source" }, "tests/rifts-law-hang.fixture.ts"), "a created Rift is listed under its source, on its branch and clean; the source, a directory in it and the Rift all have that source"),
    ], { concurrency: 2, discard: true })
  }),
  hangGuard("short-fixture"),
)

test("a fixture's cross-module global slot only accepts a symbol", () => {
  expect(() => globalSlot("Date")).toThrow(/symbol/)
  const key = Symbol("fixture")
  const slot = globalSlot<number>(key)
  expect(slot.get()).toEqual(Option.none())
  slot.set(42)
  expect(globalSlot<number>(key).get()).toEqual(Option.some(42))
  slot.clear()
})

test("measurement failures name the target, budget, reading and host load", () => {
  expect(() => measured("a controlled sample", "< 20 ms", ({ sample }) => sample(20))).toThrow(
    /a controlled sample: budget < 20 ms; measured 20 ms; host load/,
  )
})

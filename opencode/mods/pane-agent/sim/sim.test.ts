// reads: none (every world is in memory: no file system, no Rex, no agy, no network)
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { defaultConfig } from "./driver.ts"
import { mergeCoverage, type PlannedFault, unhitPairs } from "./faults.ts"
import { CORE, INJECTED } from "./generator.ts"
import { formatViolations } from "./invariants.ts"
import { knownRed } from "./known-red.ts"
import { awaitJobs, crashJobs, pairJobs, randomJobs, report, runBatch, runOne, runScenario, SEEDS, shrink } from "./property.ts"
import { reportRunner } from "./register.ts"
import { type Scenario, SCENARIOS } from "./scenarios.ts"
import { type Break, DEFAULT_WORLD } from "./world.ts"

const claims = (scenario: Scenario): string =>
  Object.entries(scenario.triggers)
    .map(([head, triggers]) => `${head}: ${(triggers ?? []).join(", ")}`)
    .join("; ")

const scenarioReport = (scenario: Scenario) =>
  Effect.map(runScenario(scenario), (result) => {
    if (result.violations.length === 0) return ""
    return `${report(result, result.trace.fired, result.violations)}\n  claims: ${claims(scenario) || "none (a regression net)"}`
  })

const batchReport = (label: string, jobs: Parameters<typeof runBatch>[1], shrinkFirst: number) =>
  Effect.map(runBatch(label, jobs, shrinkFirst), (batch) => {
    if (batch.red.length === 0) return ""
    return batch.text
  })

/**
 * Registers one acceptance check. A check named in KNOWN_RED_AT_BASE (sim/known-red.ts) is held as
 * `test.failing`, the repo's red-first form: red is its expected state at 44f5ed09 until the shell rewrite lands.
 */
const simTest = (key: string, what: string, body: Effect.Effect<string>) => {
  const held = knownRed(key)
  if (Option.isSome(held)) return test.failing(`pane-agent-sim ${key}: ${what} [known red at 44f5ed09: ${held.value}]`, reportRunner(key, body), hangGuard("local-fixture"))
  return test(`pane-agent-sim ${key}: ${what}`, reportRunner(key, body), hangGuard("local-fixture"))
}

describe("pane-agent-sim: the diagnosis section 4 acceptance property", () => {
  for (const scenario of SCENARIOS) simTest(`scenario ${scenario.name}`, scenario.what, scenarioReport(scenario))

  simTest(
    "batch crash",
    "the process crashes at every effect index of the happy trace and restarts on the same world",
    Effect.flatMap(crashJobs(), (jobs) => batchReport("crash", jobs, 3)),
  )

  for (const command of INJECTED) {
    simTest(
      `batch await:${command.name}`,
      `${command.name} injected at every await point of start, turn 1, a follow_up and turn 2 (the idle-confirm wait included)`,
      Effect.flatMap(awaitJobs(command), (jobs) => batchReport(`await:${command.name}`, jobs, 1)),
    )
  }

  simTest("batch seeds", `${SEEDS.length} seeded random runs: commands, owner actions, crashes, a second server, random faults`, batchReport("seeds", randomJobs(SEEDS), 3))

  simTest("batch pairs", "one run per (boundary, fault) pair, the fault on that boundary's second call", batchReport("pairs", pairJobs(), 3))

  effectTest(
    "pane-agent-sim coverage: the seed set hits every (boundary, fault) pair at least once",
    Effect.gen(function* () {
      const pairs = yield* runBatch("pairs", pairJobs(), 0)
      const seeds = yield* runBatch("seeds", randomJobs(SEEDS), 0)
      const coverage = new Map(pairs.coverage)
      mergeCoverage(coverage, seeds.coverage)
      expect(unhitPairs(coverage), "(boundary, fault) pairs the seed set never hit").toEqual([])
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "pane-agent-sim reports name the seed, the minimal fault list and the broken invariant",
    Effect.gen(function* () {
      const breaks: ReadonlyArray<Break> = ["drop-done-wakes"]
      const harmless: PlannedFault = { boundary: "notifier.changed", nth: 2, fault: "late" }
      const config = { ...defaultConfig("report-check", 7), world: { ...DEFAULT_WORLD, breaks }, faults: [harmless] }
      const result = yield* runOne(config, CORE)
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.trace.fired.length).toBeGreaterThan(0)
      const minimal = yield* shrink(result)
      const text = report(result, minimal.faults, minimal.violations)
      expect(text.split("\n")[0]).toBe("SIM-RED name=report-check seed=7 faults=[]")
      expect(formatViolations(minimal.violations)).toMatch(/\[I4 settle and wake\]/)
    }),
    hangGuard("in-memory"),
  )
})

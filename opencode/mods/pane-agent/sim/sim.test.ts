// reads: none (every world is in memory: no file system, no Rex, no agy, no network)
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { defaultConfig, type SimConfig, type Step } from "./driver.ts"
import { mergeCoverage, type PlannedFault, unhitPairs } from "./faults.ts"
import { CORE, INJECTED } from "./generator.ts"
import { formatViolations } from "./invariants.ts"
import { isPinned, reasonOf } from "./known-red.ts"
import { awaitJobs, crashJobs, pairJobs, randomJobs, report, runBatch, runOne, runScenario, SEEDS, shrink, signaturesOf, slice } from "./property.ts"
import { type CheckResult, pinnedRunner } from "./register.ts"
import { type Scenario, SCENARIOS } from "./scenarios.ts"
import { type Break, DEFAULT_WORLD } from "./world.ts"

const claims = (scenario: Scenario): string =>
  Object.entries(scenario.triggers)
    .map(([head, triggers]) => `${head}: ${(triggers ?? []).join(", ")}`)
    .join("; ")

const scenarioCheck = (scenario: Scenario): Effect.Effect<CheckResult> =>
  Effect.map(runScenario(scenario), (result) => {
    if (result.violations.length === 0) return { fingerprint: {}, report: "" }
    return {
      fingerprint: { [scenario.name]: signaturesOf(result.violations) },
      report: `${report(result, result.trace.fired, result.violations)}\n  claims: ${claims(scenario) || "none (a regression net)"}`,
    }
  })

type Job = Effect.Effect<{ readonly config: SimConfig; readonly steps: ReadonlyArray<Step> }>

const batchCheck = (label: string, jobs: Effect.Effect<ReadonlyArray<Job>>, k: number, of: number, shrinkFirst: number): Effect.Effect<CheckResult> =>
  Effect.flatMap(jobs, (all) => Effect.map(runBatch(`${label} ${k + 1}/${of}`, slice(all, k, of), shrinkFirst), (batch) => ({ fingerprint: batch.fingerprint, report: batch.text })))

/**
 * Registers one acceptance check as a plain test that holds its pin exactly (SPEC v2 ruling 7; sim/known-red.ts).
 * A check pinned red at 44f5ed09 says so in its name; every other check must be green.
 */
const check = (key: string, what: string, body: Effect.Effect<CheckResult>) => {
  if (isPinned(key)) return test(`pane-agent-sim ${key}: ${what} [pinned red at 44f5ed09: ${reasonOf(key)}]`, pinnedRunner(key, body), hangGuard("local-fixture"))
  return test(`pane-agent-sim ${key}: ${what}`, pinnedRunner(key, body), hangGuard("local-fixture"))
}

const slices = (label: string, of: number, what: string, jobs: Effect.Effect<ReadonlyArray<Job>>, shrinkFirst: number) => {
  for (let k = 0; k < of; k++) check(`batch ${label} ${k + 1}/${of}`, what, batchCheck(label, jobs, k, of, shrinkFirst))
}

describe("pane-agent-sim: the diagnosis section 4 acceptance property", () => {
  for (const scenario of SCENARIOS) check(`scenario ${scenario.name}`, scenario.what, scenarioCheck(scenario))

  slices("crash", 4, "the process crashes at every effect index of the happy trace and restarts on the same world", crashJobs(), 2)

  for (const command of INJECTED) {
    slices(`await:${command.name}`, 4, `${command.name} injected at every await point of two starts, turn 1, a follow_up and turn 2 (the idle-confirm wait included)`, awaitJobs(command), 1)
  }

  slices("seeds", 6, `${SEEDS.length} seeded random runs: two workers, a named pane, commands, owner actions, crashes, a second server, random faults`, Effect.succeed(randomJobs(SEEDS)), 2)

  slices("pairs", 6, "one run per (boundary, fault, call): the fault on that boundary's first, second or third call", Effect.succeed(pairJobs()), 2)

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

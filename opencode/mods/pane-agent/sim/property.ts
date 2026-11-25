import { Effect, Option } from "effect"
import { defaultConfig, runScript, type SimConfig, type Step, type Trace } from "./driver.ts"
import { mergeCoverage, type PlannedFault } from "./faults.ts"
import { CORE, INJECTED, PAIR_SCRIPT, pairConfigs, randomConfig } from "./generator.ts"
import { checkAll, formatViolations, signatureOf, type Violation } from "./invariants.ts"
import { configOf, HAPPY, type Scenario } from "./scenarios.ts"

export interface RunResult {
  readonly name: string
  readonly seed: number
  readonly trace: Trace
  readonly violations: ReadonlyArray<Violation>
  readonly config: SimConfig
  readonly steps: ReadonlyArray<Step>
}

export const runOne = Effect.fn("Sim.runOne")(function* (config: SimConfig, steps: ReadonlyArray<Step>) {
  const trace = yield* runScript(config, steps)
  const result: RunResult = { name: config.name, seed: config.seed, trace, violations: checkAll(trace), config, steps }
  return result
})

export const runScenario = (scenario: Scenario) => runOne(configOf(scenario), scenario.steps)

export const formatFault = (fault: PlannedFault): string => `${fault.boundary}#${fault.nth}:${fault.fault}`

/**
 * Shrinks a red run to a minimal fault list: replays it with the random picks turned into a planned list
 * (by boundary and call number) and drops faults one at a time while the run stays red.
 */
export const shrink = Effect.fn("Sim.shrink")(function* (result: RunResult) {
  const replay = (list: ReadonlyArray<PlannedFault>) =>
    runOne({ ...result.config, random: Option.none(), crashAt: Option.none(), faults: list }, result.steps)
  let current: ReadonlyArray<PlannedFault> = result.trace.fired
  if (Option.isSome(result.config.crashAt)) return { faults: current, violations: result.violations }
  let violations = result.violations
  const confirmed = yield* replay(current)
  if (confirmed.violations.length === 0) return { faults: current, violations }
  violations = confirmed.violations
  for (let i = 0; i < current.length; ) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)]
    const rerun = yield* replay(candidate)
    if (rerun.violations.length > 0) {
      current = candidate
      violations = rerun.violations
    } else {
      i++
    }
  }
  return { faults: current, violations }
})

/** The lines a red run prints: the result marker, its seed or scenario, the minimal fault list, the first violations. */
export const report = (result: RunResult, minimal: ReadonlyArray<PlannedFault>, violations: ReadonlyArray<Violation>): string =>
  [
    `SIM-RED name=${result.name} seed=${result.seed} faults=[${minimal.map(formatFault).join(", ")}]`,
    formatViolations(violations.slice(0, 6)),
  ].join("\n")

/** A check's red set: each red job (scenario or batch run) by name, with the exact set of its violation signatures (sorted). */
export type Fingerprint = Readonly<Record<string, ReadonlyArray<string>>>

export const invariantsOf = (violations: ReadonlyArray<Violation>): ReadonlyArray<number> => [...new Set(violations.map((item) => item.invariant))].sort((a, b) => a - b)

/** A job's violation signatures as a multiset (ruling 7, widened): every occurrence counts, sorted. */
export const signaturesOf = (violations: ReadonlyArray<Violation>): ReadonlyArray<string> => violations.map(signatureOf).sort()

/** The invariant ids a signature set names (each signature starts with "I<n> "). */
export const invariantsOfSignatures = (signatures: ReadonlyArray<string>): ReadonlyArray<number> =>
  [...new Set(signatures.map((signature) => Number(signature.slice(1, signature.indexOf(" ")))))].sort((a, b) => a - b)

export const formatInvariants = (ids: ReadonlyArray<number>): string => `[${ids.map((id) => `I${id}`).join(" ")}]`

export interface BatchResult {
  readonly runs: number
  readonly red: ReadonlyArray<RunResult>
  readonly coverage: ReadonlyMap<string, number>
  readonly fingerprint: Fingerprint
  readonly text: string
}

/** Runs a batch; prints a summary line, every red job with its invariants, and the minimal faults of the first red runs. */
export const runBatch = Effect.fn("Sim.runBatch")(function* (
  label: string,
  jobs: ReadonlyArray<Effect.Effect<{ readonly config: SimConfig; readonly steps: ReadonlyArray<Step> }>>,
  shrinkFirst: number,
) {
  const red: Array<RunResult> = []
  const coverage = new Map<string, number>()
  for (const job of jobs) {
    const { config, steps } = yield* job
    const result = yield* runOne(config, steps)
    mergeCoverage(coverage, result.trace.coverage)
    if (result.violations.length > 0) red.push(result)
  }
  const fingerprint: Fingerprint = Object.fromEntries(red.map((result) => [result.name, signaturesOf(result.violations)]))
  const lines = [`SIM-BATCH ${label}: ${red.length} red of ${jobs.length} runs`, ...red.map((result) => `SIM-JOB ${result.name} ${formatInvariants(invariantsOf(result.violations))}`)]
  for (const result of red.slice(0, shrinkFirst)) {
    const minimal = yield* shrink(result)
    lines.push(report(result, minimal.faults, minimal.violations))
  }
  const batch: BatchResult = { runs: jobs.length, red, coverage, fingerprint, text: lines.join("\n") }
  return batch
})

/** Every `of`-th job from the k-th: a batch is registered as slices so each check stays well under its cap. */
export const slice = <A>(items: ReadonlyArray<A>, k: number, of: number): ReadonlyArray<A> => items.filter((_, i) => i % of === k)

const job = (config: SimConfig, steps: ReadonlyArray<Step>) => Effect.succeed({ config, steps })

/** The effect count of the happy trace, so a crash is enumerated at every one of its effect indices. */
export const effectCount = Effect.fn("Sim.effectCount")(function* (steps: ReadonlyArray<Step>) {
  const trace = yield* runScript({ ...defaultConfig("count", 0), probe: false }, steps)
  return trace.effects.filter((effect) => effect.boundary !== "process.start").length
})

export const crashJobs = Effect.fn("Sim.crashJobs")(function* () {
  const total = yield* effectCount(HAPPY)
  return Array.from({ length: total }, (_, index) => job({ ...defaultConfig(`crash@${index}`, index), crashAt: Option.some(index) }, HAPPY))
})

export const awaitJobs = Effect.fn("Sim.awaitJobs")(function* (command: (typeof INJECTED)[number]) {
  const total = yield* effectCount(CORE)
  return Array.from({ length: total }, (_, index) =>
    job({ ...defaultConfig(`await:${command.name}@${index}`, index), gateAt: Option.some({ index, commands: command.commands(index) }) }, CORE),
  )
})

export const pairJobs = () => pairConfigs().map((config) => job(config, PAIR_SCRIPT))

export const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1)

export const randomJobs = (seeds: ReadonlyArray<number>) => seeds.map((seed) => randomConfig(seed))

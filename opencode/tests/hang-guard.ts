import { expect } from "bun:test"
import { Brand, Clock, Effect } from "effect"
import { osLoad } from "../mods/pool/opencode/workload.ts"

/** Emergency runner caps, never a synchronization mechanism or product budget. */
export const HANG_GUARDS = {
  "unit-law": 5_000,
  "in-memory": 10_000,
  "short-fixture": 15_000,
  "local-pair": 20_000,
  "local-fixture": 30_000,
  "readiness-fixture": 40_000,
  "wake-short": 36_000,
  "inspector": 45_000,
  "wake-process": 55_000,
  "process-fixture": 60_000,
  "process-tree": 90_000,
  "installer": 120_000,
  "fork-turn": 150_000,
  "fork-reconnect": 160_000,
  "fork-session": 180_000,
  "fork-transition": 200_000,
  "generated-schedule": 240_000,
  "cross-clock-search": 210_000,
  "acceptance": 300_000,
  "acceptance-plus-teardown": 320_000,
  "three-host-search": 360_000,
  "long-fork-scenario": 400_000,
  "deep-scenario": 600_000,
  "outside-claim-search": 630_000,
  "isolated-seed-pair": 900_000,
  "isolated-seed-trio": 1_200_000,
  "sim-parity": 3_000_000,
  "skewed-clock-search": 4_200_000,
} as const

export type HangKind = keyof typeof HANG_GUARDS
export type RunnerGuard = Brand.Branded<number, "RunnerGuard">
const guard = Brand.nominal<RunnerGuard>()
export const hangGuard = (kind: HangKind): RunnerGuard => guard(HANG_GUARDS[kind])

/** Intentional runner-timeout probes; the ratchet approves every use. */
export const probeTimeout = (milliseconds: number, _reason: string): RunnerGuard => guard(milliseconds)

const DIAGNOSTIC_MARGIN_MS = 1_000
type BridgeBudget = Brand.Branded<{ readonly deadline: number; readonly cap: RunnerGuard }, "BridgeBudget">
const budgetOf = Brand.nominal<BridgeBudget>()
export const bridgeBudget = (cap: RunnerGuard): BridgeBudget => budgetOf({ deadline: cap - DIAGNOSTIC_MARGIN_MS, cap })
export const runnerCapOf = (budget: BridgeBudget): RunnerGuard => budget.cap
export const beforeRunnerCap =
  (test: string, budget: ReturnType<typeof bridgeBudget>) =>
  <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    body.pipe(Effect.timeoutOrElse({
      duration: budget.deadline,
      orElse: () => Effect.die(`${test}: its fixture did not complete before the ${budget.deadline} ms diagnostic deadline`),
    }))

const wall = Clock.Clock.defaultValue()

/** Timestamped test data for a real peer, not an elapsed-time assertion. */
export const stamp = (): number => wall.currentTimeMillisUnsafe()

const ticks = () => wall.monotonicTimeNanosUnsafe()
const since = (start: bigint) => Number(ticks() - start) / 1_000_000

/** Wait/cleanup deadline, not a comparison that can pass a behavioral assertion. */
export const watchdog = (ms: number) => {
  const start = ticks()
  return {
    expired: () => since(start) >= ms,
    remaining: () => Math.max(0, ms - since(start)),
  }
}

type ReportedDuration = Brand.Branded<string, "ReportedDuration">
const reported = Brand.nominal<ReportedDuration>()

/** Only displayable output is exported, not a numeric elapsed reading. */
export const elapsedForReport = () => {
  const start = ticks()
  return (): ReportedDuration => reported(`${since(start)} ms`)
}

type Unit = "ms" | "cpu-ms" | "fraction of a core" | "fps"
export type ProductBudget = `${"<" | "<=" | ">" | ">="} ${number} ${Unit}`
const budgetPattern = /^(<=|>=|<|>) ([0-9]+(?:\.[0-9]+)?) (ms|cpu-ms|fraction of a core|fps)$/
export const isProductBudget = (value: string): value is ProductBudget => budgetPattern.test(value)

interface Measurement {
  /** Capture the exact product event that opens the measured interval. */
  readonly begin: () => void
  /** Compare wall time across the actual interval, without exposing elapsed time as a number. */
  readonly end: () => void
  /** Close the interval now and make its assertion after fixture release. */
  readonly endAfterRelease: () => () => void
  /** Compare an instrumented product reading (e.g. CPU of the service subprocess). */
  readonly sample: (value: number, detail?: string) => void
  /** Compare this process's user + system CPU while a synchronous exercise runs. */
  readonly cpu: (exercise: () => void) => void
}

/**
 * Keep the performance contract and host-load diagnostic in one place. Reported host load
 * cannot skip a comparison or change the budget. Externally instrumented product data can
 * supply a sample; measurements of in-process elapsed time use begin/end instead.
 */
export const measured = <A>(target: string, budget: ProductBudget, fn: (measurement: Measurement) => A): A => {
  const [, operator = "", max = "", unit = ""] = budgetPattern.exec(budget) ?? []
  const threshold = Number(max)
  const check = (value: number, detail = "") => {
    const passes = Number.isFinite(value) && (
      operator === "<" && value < threshold ||
      operator === "<=" && value <= threshold ||
      operator === ">" && value > threshold ||
      operator === ">=" && value >= threshold
    )
    const failure = () => {
      const { load, cores } = osLoad()
      return `${target}: budget ${budget}; measured ${value} ${unit}; host load ${load} across ${cores} cores. ${detail}`
    }
    const assert = (ok: boolean, detail?: string) => expect(ok, detail).toBe(true)
    if (passes) assert(passes)
    else assert(passes, failure())
  }
  let start = ticks()
  return fn({
    begin: () => { start = ticks() },
    end: () => check(since(start)),
    endAfterRelease: () => {
      const value = since(start)
      return () => check(value)
    },
    sample: check,
    cpu: (exercise) => {
      const start = process.cpuUsage()
      exercise()
      const { user, system } = process.cpuUsage(start)
      check(Math.round((user + system) / 1000))
    },
  })
}

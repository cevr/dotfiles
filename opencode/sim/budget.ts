import { Brand } from "effect"

/** Bun gives the simulation's own wall watchdog time to publish its diagnostic. */
export const TIMEOUT_GRACE_MS = 5_000
type SimulationBudget = Brand.Branded<number, "SimulationBudget">
export const simulationBudget = Brand.nominal<SimulationBudget>()
export const simulationRunnerCapOf = (budget: SimulationBudget) => budget + TIMEOUT_GRACE_MS

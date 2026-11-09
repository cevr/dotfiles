// The model experiment: one role's new starts split into two arms, the trial
// arm on the experiment's model and the control arm on the role's own, so the
// model eval (skills/orchestrate/scripts/models.ts --experiment) can compare
// them. A unit's arm is a hash of the role and the unit's name, so every start
// of that role for the unit (its replans, a fresh agent for a later round)
// lands in one arm. A follow-up keeps its child's model and is in no arm here:
// moving a session to another model rewrites its whole cache.
import { described } from "./described.ts"

/** The experiment's settings, from the plugin's options: `share` of `role`'s units run on `model`. */
export interface Experiment {
  readonly role: string
  /** `provider/id`, with no variant: a start runs at its role's effort. */
  readonly model: string
  /** The trial arm's share of units, from 0 to 1. */
  readonly share: number
}

export type Arm = "trial" | "control"

/**
 * What a start's line records of its arm: the arm, the trial's model, and why a trial start ran
 * on the normal chain. A type, not an interface, so a latch's JSON context can keep it.
 */
export type ArmRecord = {
  readonly arm: Arm
  readonly model: string
  readonly fellBack?: string
}

const ROUND = /^r\d+$/

/** The unit a step's description names (`planner auth r1`, `auth planner r2`), if any. */
export const unitNamed = (description: string | undefined): string | undefined => {
  const step = described(description)
  const unit = step?.rest.split(" ")[0]
  return unit === undefined || unit === "" || ROUND.test(unit) || unit.startsWith("(") ? undefined : unit
}

/** FNV-1a, 32 bits, as a fraction of 2^32: a stable spread with no dependency. */
const fraction = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 2 ** 32
}

/** The arm of `unit`'s starts of the experiment's role: deterministic, the trial for about `share` of units. */
export const armOf = (experiment: Experiment, unit: string): Arm => (fraction(`${experiment.role}:${unit}`) < experiment.share ? "trial" : "control")

/**
 * The arm a start is in: none when no experiment is set, the start is a
 * follow-up, it runs as another agent, it names a model of its own, or it
 * has no description. A free-form description (`Revise #197 ownership plan`)
 * names no unit, so the description itself stands in for one.
 */
export const armFor = (
  experiment: Experiment | undefined,
  start: { readonly agent: string; readonly followUp: boolean; readonly namedModel: boolean; readonly description: string | undefined },
): { readonly arm: Arm; readonly unit: string } | undefined => {
  if (experiment === undefined || start.followUp || start.namedModel || start.agent !== experiment.role) return undefined
  const free = start.description?.trim().toLowerCase().replace(/\s+/g, " ")
  const unit = unitNamed(start.description) ?? (free ? free : undefined)
  return unit === undefined ? undefined : { arm: armOf(experiment, unit), unit }
}

// A launch is a forecast, not a quota guarantee. Learn the floor for the next
// agent from completed agents of its model family; running agents are censored
// samples, and must not make a long job look like a cheap completed one.
import { Match, Option } from "effect"
import { familyOf } from "./limits.ts"

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const MIN_SAMPLES = 3

export interface Sample {
  readonly model: string
  readonly at: number
  /** Share of one account's shared weekly quota, estimated from actual tokens. */
  readonly cost: number
}

export interface Estimate {
  readonly cost: number
  readonly samples: number
  readonly source: "hour" | "day" | "floor"
}

export const estimate = (history: ReadonlyArray<Sample>, model: Option.Option<string>, now: number, floor: number): Estimate => {
  if (Option.isNone(model)) return { cost: floor, samples: 0, source: "floor" }
  const family = familyOf(model.value)
  const day = history.filter((sample) => sample.at <= now && sample.at > now - DAY &&
    Number.isFinite(sample.cost) && sample.cost > 0 && familyOf(sample.model) === family)
  const hour = day.filter((sample) => sample.at > now - HOUR)
  const cohort = Match.value(hour.length >= MIN_SAMPLES).pipe(Match.when(true, () => hour), Match.orElse(() => day))
  if (cohort.length === 0) return { cost: floor, samples: 0, source: "floor" }
  // Three floor-valued observations are the prior until real work replaces
  // them. One large job can already raise the next launch's estimate.
  const prior = Math.max(0, MIN_SAMPLES - cohort.length)
  const mean = (cohort.reduce((sum, sample) => sum + sample.cost, 0) + prior * floor) / (cohort.length + prior)
  const source = Match.value(cohort === hour).pipe(Match.when(true, () => "hour" as const), Match.orElse(() => "day" as const))
  return { cost: Math.max(floor, mean), samples: cohort.length, source }
}

// Each account owns its weekly cycle and any refund its own claim observed.
import { Option } from "effect"

export const WEEK = 7 * 86400000
/** Stop at 99% of the provider's weekly limit; the even line has five points of leeway. */
export const TARGET = 0.99
const LEEWAY = 0.05

/**
 * What a reset the pool claimed did to an account's spend-evenly line
 * (resets.ts `pacePlans`). A reset in hand moves nothing: it is room only once
 * claimed, sent once under the fleet's lease, and a fresh reading after it
 * observed the week lower than before. Once one was claimed at `rebase.at`,
 * leaving the week at `rebase.from`, the line starts again there and spends
 * the rest evenly to the weekly reset.
 */
export interface PacePlan {
  readonly rebase?: {
    readonly at: number
    readonly from: number
    /** The claim whose room it is (`Spend.claim`). */
    readonly key?: string
    /** The share of the week reserved on that room by requests admitted on it (resets.ts `Spend`). */
    readonly spent?: number
  }
}

/**
 * The share of its week an account has used as far as the pace may know: the
 * reading's, plus, on a claim's room, every request admitted on that room
 * (`spent`) that the reading does not yet show: only the week's rise since
 * the claim's observation covers them. A reading that lags the requests sent
 * never gives their reservation back; one that shows the week risen past them
 * has covered them; one lower than the observation (more given back since)
 * covers none.
 */
export const usedOf = (reading: number, plan?: PacePlan): number =>
  Option.match(Option.flatMap(Option.fromUndefinedOr(plan), (plan) => Option.fromUndefinedOr(plan.rebase)), {
    onNone: () => reading,
    onSome: (rebase) => reading + Math.max(0, Option.getOrElse(Option.fromUndefinedOr(rebase.spent), () => 0) - Math.max(0, reading - rebase.from)),
  })

/** An account's spend-evenly line now: the share of its week it may have used. */
export const lineOf = (resetAt: number, now: number, plan?: PacePlan): number => {
  const left = (resetAt - now) / WEEK
  const rebase = Option.flatMap(Option.fromUndefinedOr(plan), (plan) => Option.fromUndefinedOr(plan.rebase))
  if (Option.isSome(rebase) && rebase.value.at <= now && rebase.value.at > resetAt - WEEK && resetAt > rebase.value.at)
    return rebase.value.from + (TARGET - rebase.value.from) * ((now - rebase.value.at) / (resetAt - rebase.value.at)) + LEEWAY
  return TARGET * (1 - left) + LEEWAY
}

/** A usable account's observed cycle; `used` includes any unobserved refund reservations. */
export interface Cycle {
  readonly credentialID: string
  readonly used: number
  readonly resetAt: number
  readonly plan?: PacePlan
}

const lineAt = (cycle: Cycle, at: number, ordinary: boolean): number => {
  const planned = lineOf(cycle.resetAt, at, cycle.plan)
  if (ordinary) return Math.min(planned, lineOf(cycle.resetAt, at, {}))
  return planned
}
const roomAt = (cycles: ReadonlyArray<Cycle>, at: number, ordinary: boolean) =>
  cycles.reduce((sum, cycle) => sum + Math.max(0, lineAt(cycle, at, ordinary) - cycle.used), 0)
const readyAt = (cycles: ReadonlyArray<Cycle>, at: number, ordinary: boolean) =>
  cycles.filter((cycle) => cycle.used <= lineAt(cycle, at, ordinary) + 1e-9)

/** Earliest millisecond with enough positive room, bounded by the first reset. */
const catchUpAt = (cycles: ReadonlyArray<Cycle>, now: number, charged: number): number => {
  let before = now
  let after = Math.min(...cycles.map((cycle) => cycle.resetAt))
  const enough = (at: number) => cycles.some((cycle) => cycle.used <= lineAt(cycle, at, false)) && roomAt(cycles, at, false) >= charged
  if (!enough(after)) return after
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2)
    if (enough(middle)) after = middle
    else before = middle
  }
  return after + 1
}

/** Positive room only: an ahead-of-pace account contributes no debt to another. */
export const weeklyPace = (cycles: ReadonlyArray<Cycle>, now: number, charged: number) => {
  const ordinary = readyAt(cycles, now, true)
  const withinOrdinary = ordinary.length > 0 && charged <= roomAt(cycles, now, true) + 1e-9
  const backed = readyAt(cycles, now, false).length > 0 && charged <= roomAt(cycles, now, false) + 1e-9
  const retry = Option.filter(Option.some(cycles), () => !backed && cycles.length > 0)
  return {
    ordinary: withinOrdinary,
    backed,
    eligible: ordinary.map((cycle) => cycle.credentialID),
    retryAt: Option.map(retry, (cycles) => catchUpAt(cycles, now, charged)),
  }
}

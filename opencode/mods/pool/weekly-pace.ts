// Each account owns its weekly cycle and any refund its own claim observed.
import { Option } from "effect"

export const WEEK = 7 * 86400000
/** Stop at 99% of the provider's weekly limit; the even line has five points of leeway. */
export const TARGET = 0.99
const LEEWAY = 0.05

/**
 * Approved cadence-preserving stock schedules existing quota faster. A refund
 * is usable only after a claim's fresh observation; its line then starts at
 * the observed usage and spends the remaining capacity to the same deadline.
 */
export interface PacePlan {
  /** Cadence-preserving credits schedule existing quota faster, without bypassing a limit. */
  readonly capacity?: { readonly extra: number; readonly expiresAt?: number }
  readonly rebase?: {
    readonly at: number
    readonly from: number
    /** The claim whose room it is (`Spend.claim`). */
    readonly key?: string
    /** The share of the week reserved on that room by requests admitted on it (resets.ts `Spend`). */
    readonly spent?: number
  }
}

/** Ordinary scheduling retains known credits, but not a claimed refund's reservations. */
export const ordinaryPlan = (plan?: PacePlan): PacePlan => Option.match(
  Option.flatMap(Option.fromUndefinedOr(plan), (plan) => Option.fromUndefinedOr(plan.capacity)),
  { onNone: () => ({}), onSome: (capacity) => ({ capacity }) },
)

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
const originOf = (resetAt: number, now: number, plan?: PacePlan) => {
  const rebase = Option.flatMap(Option.fromUndefinedOr(plan), (plan) => Option.fromUndefinedOr(plan.rebase))
  if (Option.isSome(rebase) && rebase.value.at <= now && rebase.value.at > resetAt - WEEK && resetAt > rebase.value.at)
    return { at: rebase.value.at, from: rebase.value.from }
  return { at: resetAt - WEEK, from: 0 }
}

/** An expiring credit needs the current allowance exhausted before its last-call deadline. */
const expiryLine = (origin: { readonly at: number; readonly from: number }, now: number, deadline: number): number => {
  if (deadline <= origin.at) return TARGET + LEEWAY
  const progress = Math.min(1, Math.max(0, (now - origin.at) / (deadline - origin.at)))
  return origin.from + (TARGET - origin.from) * progress + LEEWAY
}

export const lineOf = (resetAt: number, now: number, plan?: PacePlan): number => {
  const origin = originOf(resetAt, now, plan)
  const capacity = Option.flatMap(Option.fromUndefinedOr(plan), (plan) => Option.fromUndefinedOr(plan.capacity))
  const target = TARGET + Option.match(capacity, { onNone: () => 0, onSome: (capacity) => capacity.extra })
  const paced = origin.from + (target - origin.from) * ((now - origin.at) / (resetAt - origin.at)) + LEEWAY
  const expires = Option.flatMap(capacity, (capacity) => Option.filter(Option.fromUndefinedOr(capacity.expiresAt), (at) => at < resetAt))
  return Option.match(expires, { onNone: () => paced, onSome: (deadline) => Math.max(paced, expiryLine(origin, now, deadline)) })
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
  if (ordinary) return Math.min(planned, lineOf(cycle.resetAt, at, ordinaryPlan(cycle.plan)))
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

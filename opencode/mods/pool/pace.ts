// Quota-space admission, across every harness spending these accounts. The
// shared Claude budget scans Claude transcripts only, so its calibrated
// cost/agent estimates exclude OpenCode. Here 99% of the weekly allowance is
// spent evenly, with 5 percentage points of leeway. No tokens or USD are
// mistaken for provider quota. This is less predictive than the shared queue.
// A held start latches until retryAt (orchestrate's latch, a wake of its
// parent's), and is decided again then; nothing grants a stale slot.
//
// A reading lags the agents just admitted, on this host and on the others of
// the fleet (fleet.ts): each start that has not settled yet is charged a fixed
// share of one account's week until it has, so a wave on one host holds the
// next start on any host before the readings show it.
import { Schema } from "effect"
import { limitsModel, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"

const WEEK = 7 * 86400000
const TARGET = 0.99
const LEEWAY = 0.05

/** The pace method's answer: whether a new agent may start now, and if not, when to ask again. */
export const Pace = Schema.Struct({
  ok: Schema.Boolean,
  measured: Schema.Boolean,
  reason: Schema.String,
  retryAt: Schema.optionalKey(Schema.Number),
  /** A hold of the spend-evenly target only: the accounts still have quota. */
  soft: Schema.optionalKey(Schema.Boolean),
})
export type Pace = typeof Pace.Type

/** The answer for a provider the pool does not hold. */
export const UNPOOLED: Pace = { ok: true, measured: false, reason: "provider is not pooled" }

/**
 * The agents admitted in the fleet whose spend may not show in a reading yet:
 * when each started (epoch ms), what each is charged (a share of one account's
 * week, 0 to 1) and how long until a start has settled into the readings.
 */
export interface Inflight {
  readonly starts: ReadonlyArray<number>
  readonly cost: number
  readonly settleMs: number
}

export const NO_INFLIGHT: Inflight = { starts: [], cost: 0, settleMs: 0 }

/**
 * Until when an account cannot take a start of `model`: its hold, and, for a
 * model with a window of its own on the account (`7d:Fable` for
 * `claude-fable-5-2`), that window while it is spent. None when it can.
 */
const blockedUntil = (account: AccountStatus, now: number, model: string | undefined): number | undefined => {
  const untils = [
    ...(account.hold !== undefined && account.hold.until > now ? [account.hold.until] : []),
    ...(model === undefined
      ? []
      : (account.reading?.windows ?? []).flatMap((w) => {
          const scope = scopeOf(w.name)
          return scope !== undefined && limitsModel(scope, model) && w.utilization >= 1 && w.resetAt !== undefined && w.resetAt > now
            ? [w.resetAt]
            : []
        })),
  ]
  return untils.length ? Math.max(...untils) : undefined
}

/**
 * What an account's resets do to its spend-evenly line (resets.ts
 * `pacePlans`). A reset gives use back but keeps the weekly reset date, so it
 * is worth most spent early: while the account holds one that gives back
 * `spare` of the week, the line is raised by that much, fading with the week
 * left, so the first 100% may go fast. Once one was claimed at `rebase.at`,
 * leaving the week at `rebase.from`, the line starts again there and spends
 * the rest evenly to the weekly reset.
 */
export interface PacePlan {
  readonly spare?: number
  readonly rebase?: { readonly at: number; readonly from: number }
}

/** An account's spend-evenly line now: the share of its week it may have used. */
export const lineOf = (resetAt: number, now: number, plan: PacePlan | undefined): number => {
  const left = (resetAt - now) / WEEK
  const rebase = plan?.rebase
  const base =
    rebase !== undefined && rebase.at <= now && rebase.at > resetAt - WEEK && resetAt > rebase.at
      ? rebase.from + (TARGET - rebase.from) * ((now - rebase.at) / (resetAt - rebase.at))
      : TARGET * (1 - left)
  return base + LEEWAY + (plan?.spare ?? 0) * Math.max(left, 0)
}

/**
 * The pace of a pool whose accounts read `accounts` at `now`, with the agents
 * `inflight` charged on top, for a start of `model` when one is named. A
 * model's own weekly window (`7d:Fable`) holds only that model's starts; the
 * account's 5-hour and weekly windows hold every start, since every model's
 * requests spend them. `plans` moves an account's line by its resets.
 */
export function poolPace(
  accounts: ReadonlyArray<AccountStatus>,
  now: number,
  inflight: Inflight = NO_INFLIGHT,
  model?: string,
  plans: Readonly<Record<string, PacePlan>> = {},
): Pace {
  if (!accounts.length) return { ok: true, measured: false, reason: "no pooled account readings" }
  const available = accounts.filter((a) => blockedUntil(a, now, model) === undefined)
  if (!available.length) {
    const untils = accounts.flatMap((a) => {
      const until = blockedUntil(a, now, model)
      return until === undefined ? [] : [until]
    })
    const scoped = accounts.some((a) => a.hold === undefined || a.hold.until <= now)
    return {
      ok: false,
      measured: true,
      reason: scoped ? `every pool account has spent ${model}'s own weekly window` : "all pool accounts are held",
      retryAt: Math.min(...untils),
    }
  }
  const known = accounts.flatMap((a) => {
    const w = a.reading?.windows.find((w) => w.name === "7d")
    return w?.resetAt !== undefined && w.resetAt > now && w.resetAt <= now + WEEK
      ? [{ used: w.utilization, resetAt: w.resetAt, plan: plans[a.credentialID] }]
      : []
  })
  const short = available.flatMap((a) => {
    const resets = (a.reading?.windows ?? []).flatMap((w) =>
      w.resetAt !== undefined && w.resetAt > now && ((w.name === "5h" && w.utilization >= 0.9) || (w.name === "7d" && w.utilization >= TARGET))
        ? [w.resetAt]
        : [],
    )
    return resets.length ? [Math.max(...resets)] : []
  })
  if (short.length === available.length) return { ok: false, measured: true, reason: "the pool's quota windows have no room", retryAt: Math.min(...short) }
  if (!known.length) return { ok: true, measured: false, reason: "weekly pace unmeasured" }
  const read = known.reduce((n, a) => n + a.used, 0)
  const charged = inflight.starts.length * inflight.cost
  const spent = read + charged
  const allowance = known.reduce((n, a) => n + lineOf(a.resetAt, now, a.plan), 0)
  if (spent <= allowance + 1e-9) return { ok: true, measured: true, reason: "the pool is within its weekly pace" }
  const catchesUp = now + ((spent - allowance) * WEEK) / (known.length * TARGET)
  const settles = inflight.starts.length ? [Math.min(...inflight.starts) + inflight.settleMs + 1] : []
  const starting = inflight.starts.length
    ? `, +${(100 * charged).toFixed(1)}% for ${inflight.starts.length} agent${inflight.starts.length === 1 ? "" : "s"} started in the last ${Math.round(inflight.settleMs / 60_000)} min`
    : ""
  return {
    ok: false,
    measured: true,
    soft: true,
    reason: `the pool's weekly pace is over (${(100 * read).toFixed(1)}% spent across ${known.length} accounts${starting})`,
    retryAt: Math.min(Math.ceil(catchesUp) + 1, ...settles, ...known.map((a) => a.resetAt)),
  }
}

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

/** The pace of a pool whose accounts read `accounts` at `now`, with the agents `inflight` charged on top. */
export function poolPace(accounts: ReadonlyArray<AccountStatus>, now: number, inflight: Inflight = NO_INFLIGHT): Pace {
  if (!accounts.length) return { ok: true, measured: false, reason: "no pooled account readings" }
  const available = accounts.filter((a) => !a.hold || a.hold.until <= now)
  if (!available.length) {
    const untils = accounts.flatMap((a) => (a.hold === undefined ? [] : [a.hold.until]))
    return { ok: false, measured: true, reason: "all pool accounts are held", retryAt: Math.min(...untils) }
  }
  const known = accounts.flatMap((a) => {
    const w = a.reading?.windows.find((w) => w.name === "7d")
    return w?.resetAt !== undefined && w.resetAt > now && w.resetAt <= now + WEEK ? [{ used: w.utilization, resetAt: w.resetAt }] : []
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
  const allowance = known.reduce((n, a) => n + TARGET * (1 - (a.resetAt - now) / WEEK) + LEEWAY, 0)
  if (spent <= allowance + 1e-9) return { ok: true, measured: true, reason: "the pool is within its weekly pace" }
  const catchesUp = now + ((spent - allowance) * WEEK) / (known.length * TARGET)
  const settles = inflight.starts.length ? [Math.min(...inflight.starts) + inflight.settleMs + 1] : []
  const starting = inflight.starts.length
    ? `, +${(100 * charged).toFixed(1)}% for ${inflight.starts.length} agent${inflight.starts.length === 1 ? "" : "s"} started in the last ${Math.round(inflight.settleMs / 60_000)} min`
    : ""
  return {
    ok: false,
    measured: true,
    reason: `the pool's weekly pace is over (${(100 * read).toFixed(1)}% spent across ${known.length} accounts${starting})`,
    retryAt: Math.min(Math.ceil(catchesUp) + 1, ...settles, ...known.map((a) => a.resetAt)),
  }
}

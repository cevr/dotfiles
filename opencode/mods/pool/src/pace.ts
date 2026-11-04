import type { AccountStatus } from "./pool.ts"

const WEEK = 7 * 86400000
const TARGET = 0.99
const LEEWAY = 0.05
export interface Pace {
  readonly ok: boolean
  readonly measured: boolean
  readonly reason: string
  readonly retryAt?: number
}

/** Quota-space admission, across every harness spending these accounts.
 * The shared Claude budget scans Claude transcripts only, so its calibrated
 * cost/agent estimates exclude OpenCode. Here 99% of the weekly allowance is
 * spent evenly, with 5 percentage points of leeway. No tokens or USD are
 * mistaken for provider quota. This is less predictive than the shared queue.
 * A waiter wakes at retryAt and the tool rechecks; it never grants a stale slot.
 */
export function poolPace(accounts: readonly AccountStatus[], now = Date.now()): Pace {
  if (!accounts.length) return { ok: true, measured: false, reason: "no pooled account readings" }
  const available = accounts.filter((a) => !a.hold || a.hold.until <= now)
  if (!available.length) return { ok: false, measured: true, reason: "all pool accounts are held", retryAt: Math.min(...accounts.map((a) => a.hold!.until)) }
  const known = accounts.flatMap((a) => {
    const w = a.reading?.windows.find((w) => w.name === "7d")
    return w?.resetAt !== undefined && w.resetAt > now && w.resetAt <= now + WEEK ? [{ used: w.utilization, resetAt: w.resetAt }] : []
  })
  const short = available.flatMap((a) => {
    const windows = a.reading?.windows.filter((w) => w.resetAt !== undefined && w.resetAt > now && ((w.name === "5h" && w.utilization >= 0.9) || (w.name === "7d" && w.utilization >= TARGET))) ?? []
    return windows.length ? [Math.max(...windows.map((w) => w.resetAt!))] : []
  })
  if (short.length === available.length) return { ok: false, measured: true, reason: "the pool's quota windows have no room", retryAt: Math.min(...short) }
  if (!known.length) return { ok: true, measured: false, reason: "weekly pace unmeasured" }
  const spent = known.reduce((n, a) => n + a.used, 0)
  const allowance = known.reduce((n, a) => n + TARGET * (1 - (a.resetAt - now) / WEEK) + LEEWAY, 0)
  if (spent <= allowance + 1e-9) return { ok: true, measured: true, reason: "the pool is within its weekly pace" }
  const catchesUp = now + (spent - allowance) * WEEK / (known.length * TARGET)
  return { ok: false, measured: true, reason: `the pool's weekly pace is over (${(100 * spent).toFixed(1)}% spent across ${known.length} accounts)`, retryAt: Math.min(Math.ceil(catchesUp) + 1, ...known.map((a) => a.resetAt)) }
}

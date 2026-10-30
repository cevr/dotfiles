// The Codex budget: whether a new thread or a next turn fits the account's usage.
// Pure: the bridge reads the usage (`account/rateLimits/read`) and the settings.
//
// Codex reports each rate-limit window as a percentage used and its reset.
// - A long window (a week) is spent at an even rate: `target` of it by its reset.
//   A new thread starts while the use is under that even line, `leadHours`
//   ahead of now. A next turn goes on past the line, up to `target`, so a fix
//   round of work already started is not stranded.
// - A short window (5 hours) holds both from `shortMax`.
// - A spent window, or a limit Codex says is reached, holds both until it
//   resets: past the limit Codex spends paid credits.
//
// - With `sabbath` set, the even line runs over the hours outside the Sabbath
//   (the sabbath mod), when no turn runs: it stands still through it, and
//   climbs faster around it (owner, 2026-10-30).
//
// Settings: the `codex` key of ~/.config/orchestrate/budget.json overrides DEFAULTS.

import { awake, awakeAfter } from '../../sabbath/hooks/sabbath.ts'

export type Window = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
export type Limits = {
  primary?: Window | null
  secondary?: Window | null
  rateLimitReachedType?: string | null
  ordinaryUsageAllowed?: boolean | null
}
export type Config = { target: number; leadHours: number; shortMax: number; sabbath: boolean }
export const DEFAULTS: Config = { target: 0.99, leadHours: 24, shortMax: 0.9, sabbath: true }

/** Whether a call may go on; when held, why, and from when it may (ms). */
export type Gate = { ok: boolean; reason?: string; until?: number }
export type Budget = { start: Gate; send: Gate; summary: string }

const MINUTE = 60e3
const DAY = 1440
const pct = (f: number) => `${Math.round(f * 100)}%`
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'

// A held gate stays held until its latest reason clears.
const hold = (gate: Gate, reason: string, until?: number): Gate =>
  gate.ok || (gate.until !== undefined && (until === undefined || until > gate.until)) ? { ok: false, reason, until } : gate

export function budget(limits: Limits | null | undefined, now: number, c: Config = DEFAULTS): Budget {
  let start: Gate = { ok: true }
  let send: Gate = { ok: true }
  if (!limits) return { start, send, summary: 'Codex usage unknown; no budget applied.' }
  const lines: string[] = []
  const windows = [limits.primary, limits.secondary].filter((w): w is Window => typeof w?.usedPercent === 'number')
  const resets = windows.flatMap(w => (w.resetsAt ? [w.resetsAt * 1e3] : []))

  for (const w of windows) {
    const used = w.usedPercent / 100
    const reset = w.resetsAt ? w.resetsAt * 1e3 : undefined
    const mins = w.windowDurationMins ?? undefined
    const label = mins === undefined ? 'usage' : mins > DAY ? `${Math.round(mins / DAY)}-day window` : `${Math.round(mins / 60)}-hour window`
    const resetText = reset ? `, resets ${when(reset)}` : ''
    if (used >= 1) {
      const reason = `the ${label} is spent${resetText}`
      start = hold(start, reason, reset)
      send = hold(send, reason, reset)
      lines.push(`${label}: ${pct(used)} used${resetText}`)
    } else if (mins !== undefined && mins <= DAY) {
      if (used >= c.shortMax) {
        const reason = `the ${label} is ${pct(used)} used, past ${pct(c.shortMax)}${resetText}`
        start = hold(start, reason, reset)
        send = hold(send, reason, reset)
      }
      lines.push(`${label}: ${pct(used)} used of ${pct(c.shortMax)}${resetText}`)
    } else if (mins !== undefined && reset !== undefined) {
      const span = mins * MINUTE
      const lead = c.leadHours * 60 * MINUTE
      const opened = reset - span
      // The working time from the window's start to `t`, and the time a working time ends.
      const worked = (t: number) => (c.sabbath ? awake(opened, t) : t - opened)
      const at = (ms: number) => (c.sabbath && ms > 0 ? awakeAfter(opened, ms) : opened + ms)
      const whole = worked(reset)
      const line = Math.min(c.target, (c.target * (worked(now) + lead)) / whole)
      if (used >= c.target) {
        const reason = `the ${label} is ${pct(used)} used, past the ${pct(c.target)} budget${resetText}`
        start = hold(start, reason, reset)
        send = hold(send, reason, reset)
      } else if (used > line) {
        // The even line reaches this use at `onPace`.
        const onPace = at((used * whole) / c.target - lead)
        start = hold(
          start,
          `the ${label} is ${pct(used)} used; an even burn to ${pct(c.target)} by ${when(reset)} allows ${pct(line)} now, and ${pct(used)} at ${when(onPace)}`,
          onPace,
        )
      }
      lines.push(`${label}: ${pct(used)} used; even line ${pct(line)} now; ${pct(c.target)} by ${when(reset)}`)
    } else {
      lines.push(`${label}: ${pct(used)} used`)
    }
  }

  const until = resets.length ? Math.max(...resets) : undefined
  if (limits.rateLimitReachedType || limits.ordinaryUsageAllowed === false) {
    const reason = `Codex reports ${limits.rateLimitReachedType ?? 'no ordinary usage allowed'}`
    start = hold(start, reason, until)
    send = hold(send, reason, until)
  }

  const gates = start.ok ? 'new threads and next turns go on' : send.ok ? 'new threads held; next turns go on' : 'new threads and next turns held'
  return { start, send, summary: `Codex budget: ${lines.join('; ') || 'no windows reported'}. ${gates[0].toUpperCase()}${gates.slice(1)}.` }
}

/** The text of a held gate for a refused call. */
export function refusal(kind: 'start' | 'send', gate: Gate): string {
  const what = kind === 'start' ? 'a new Codex thread' : 'a next turn'
  return `The Codex budget holds ${what}: ${gate.reason}.${gate.until ? ` It opens at ${when(gate.until)}.` : ''}`
}

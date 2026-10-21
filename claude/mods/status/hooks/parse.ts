import type { Account, LimitWindow, Outlook, Pool, Run, Sample, Unit } from '../types'

const HOUR = 3600e3
const MINUTE = 60e3

// The unit states that still need work or the owner; merged, done and dropped
// units are history.
const ACTIVE = /^(plan|implement|review|verify|decide|blocked|stuck)/

// budget.ts prints one line per host, then `budget: 5/8 agents, 181 MW in 5 h`.
// The weighted-token figure stays out: the outlook answers what it hinted at.
export function parseBudget(stdout: string): Pool | undefined {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const total = lines.at(-1)?.match(/^budget: (\d+)\/(\d+) agents/)
  if (!total) return undefined
  return {
    agents: Number(total[1]),
    cap: Number(total[2]),
    hosts: lines.slice(0, -1).map(line => line.replace(/;.*$/, '')),
  }
}

// status.ts prints a Markdown table: | Unit | State | Round | Since | Cause |.
export function parseRun(name: string, stdout: string): Run {
  const units: Unit[] = []
  for (const line of stdout.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 6 || cells[1] === 'Unit' || cells[1]?.startsWith('-')) continue
    const [, unit = '', state = '', round = '', since = ''] = cells
    if (ACTIVE.test(state)) units.push({ unit, state, round: Number(round) || 0, since })
  }
  return { name, units }
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

// `teamclaude status --json`: only the quota numbers are read, labelled A1..An
// in list order, so no account name or email reaches the screen.
export function parseAccounts(stdout: string): Account[] {
  const accounts = field(JSON.parse(stdout), 'accounts')
  if (!Array.isArray(accounts)) return []
  return accounts
    .filter(account => field(account, 'disabled') !== true)
    .map((account, index) => {
      const quota = field(account, 'quota')
      return {
        label: `A${index + 1}`,
        used5h: num(field(quota, 'unified5h')) ?? 0,
        usedWeek: num(field(quota, 'unified7d')) ?? 0,
        reset5h: num(field(quota, 'unified5hReset')),
        resetWeek: num(field(quota, 'unified7dReset')),
        weekPerHour: num(field(field(field(quota, 'forecast'), 'unified7d'), 'ratePerHour')) ?? 0,
      }
    })
}

// teamclaude forecasts only the weekly burn, so the 5-hour burn comes from the
// mod's own readings: the rise of each account's use since a reading at least
// 10 minutes old. A use that fell is a reset, and counts from 0.
export function fiveHourPerHour(samples: readonly Sample[], now: number): number | undefined {
  const current = samples.at(-1)
  const base = samples.findLast(sample => sample.at <= now - 10 * MINUTE)
  if (!current || !base || current.used5h.length !== base.used5h.length) return undefined
  const rise = current.used5h.reduce((sum, used, i) => {
    const before = base.used5h[i] ?? 0
    return sum + (used >= before ? used - before : used)
  }, 0)
  return rise / ((current.at - base.at) / HOUR)
}

type Restore = { at: number; gain: number }

// The pool as one tank: the quota left now, drained at the pool's burn, and
// refilled as each account's window resets. The first moment the tank is empty
// before the next reset is a rate limit, until that reset.
function firstLimit(left: number, restores: Restore[], perHour: number, now: number, horizon: number) {
  if (perHour <= 1e-6) return undefined
  let available = left
  let at = now
  for (const restore of restores.filter(r => r.at > now).sort((a, b) => a.at - b.at)) {
    const empty = at + (available / perHour) * HOUR
    if (empty < restore.at) return { limitedAt: empty, freeAt: restore.at }
    available += restore.gain - (perHour * (restore.at - at)) / HOUR
    at = restore.at
  }
  const empty = at + (available / perHour) * HOUR
  return empty <= now + horizon ? { limitedAt: empty, freeAt: undefined } : undefined
}

export function outlook(accounts: readonly Account[], fivePerHour: number | undefined, now: number): Outlook {
  const weekPerHour = accounts.reduce((sum, a) => sum + a.weekPerHour, 0)
  const live = accounts.filter(a => a.usedWeek < 1 && a.used5h < 1)
  const limits: { window: LimitWindow; limitedAt: number; freeAt?: number }[] = []

  const week = firstLimit(
    accounts.reduce((sum, a) => sum + Math.max(0, 1 - a.usedWeek), 0),
    accounts.flatMap(a => (a.resetWeek ? [{ at: a.resetWeek, gain: Math.min(1, a.usedWeek) }] : [])),
    weekPerHour,
    now,
    7 * 24 * HOUR,
  )
  if (week) limits.push({ window: 'week', ...week })

  // Only an account with weekly quota left can serve a 5-hour window.
  const weekly = accounts.filter(a => a.usedWeek < 1)
  const five =
    fivePerHour === undefined
      ? undefined
      : firstLimit(
          weekly.reduce((sum, a) => sum + Math.max(0, 1 - a.used5h), 0),
          weekly.flatMap(a => (a.reset5h ? [{ at: a.reset5h, gain: Math.min(1, a.used5h) }] : [])),
          fivePerHour,
          now,
          5 * HOUR,
        )
  if (five) limits.push({ window: '5h', ...five })

  const first = limits.sort((a, b) => a.limitedAt - b.limitedAt)[0]
  return {
    ...first,
    live: live.length,
    total: accounts.length,
    weekPerHour,
    fiveHourPerHour: fivePerHour,
  }
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

// `rate limit in 4h30m, for 11h (weekly) · 1/7 accounts have quota`
export function statusLine(view: Outlook | undefined, now: number): string | undefined {
  if (!view || view.total === 0) return undefined
  const accounts = `${view.live}/${view.total} accounts have quota`
  if (view.limitedAt === undefined) return `no rate limit ahead · ${accounts}`
  const lasting = view.freeAt === undefined ? '' : `, for ${duration(view.freeAt - view.limitedAt)}`
  const window = view.window === 'week' ? 'weekly' : '5h'
  const when = view.limitedAt - now < MINUTE ? 'rate limited now' : `rate limit in ${duration(view.limitedAt - now)}`
  return `${when}${lasting} (${window}) · ${accounts}`
}

// The codex-bridge's policy: whether a turn waits, why and until when, the
// order latched turns start in, why a turn ended and what the bridge sends
// after one the infrastructure ended. The daemon (./bridge.ts) loads this file
// again before each decision once it or ./budget.ts changed (by mtime), so an
// edit takes effect without a restart or a drain. It keeps no state: the
// daemon passes in what it knows.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { local, sabbath } from '../../sabbath/hooks/sabbath.ts'
import type { Cause, Role, Thread } from './bridge.ts'
import type * as Budget from './budget.ts'

// This load's version passes on, so a reload reads ./budget.ts afresh too.
const { budget, DEFAULTS } = (await import(`${import.meta.dir}/budget.ts${new URL(import.meta.url).search}`)) as typeof Budget

/** Minutes a latched turn may wait before its role moves to Claude (orchestrate's Families). */
export const PATIENCE_MIN = 10
const PATIENCE_MS = PATIENCE_MIN * 60e3
const BUDGET = process.env.CODEX_BRIDGE_BUDGET ?? join(homedir(), '.config/orchestrate/budget.json')
// It reads every host over SSH; past this, the even line decides.
const ADMIT_MS = 60e3
// An admission's hold line ends with when the turn should open: `; opens about 2026-10-30 14:20Z`.
const OPENS = /; opens about (\d{4}-\d\d-\d\d) (\d\d:\d\d)Z$/
// A turn the infrastructure ended is resumed after these waits, then left to its owner.
const BACKOFF_MIN = [1, 5, 15]
const ENDED_ON: Partial<Record<Cause, string>> = {
  capacity: 'the model being at capacity',
  'app-server-exit': 'the Codex app-server exiting',
  'drain-interrupt': 'a codex-bridge restart',
  sabbath: 'the Sabbath',
}

/** Why a turn waits, and when it should open when that is known. */
export type Hold = { why: string; opensAt?: number }
/** The rate admission's answer: `ok` unset when it could not tell. */
export type Admitted = { ok?: boolean; line: string }
/** What a decision needs of a thread: a new one has no id and no turns yet. */
export type Asking = Pick<Thread, 'id' | 'model' | 'role' | 'turns' | 'status'>

export const DRAINING = 'the bridge is updating'

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`

/**
 * Whether the account's burn has room for one more thread of `model` in `role`:
 * true or false with budget.ts's line, undefined when it could not tell. The
 * command runs in the login shell, since a daemon an app started lacks the
 * shell's environment (ORCHESTRATE_HOSTS); $CODEX_BRIDGE_ADMIT, read per call,
 * stands in for it in a test.
 */
export async function admission(
  model: string | undefined,
  role: Role | undefined,
  thread?: string,
  reserve = 0,
  limits?: Budget.Limits | null,
): Promise<Admitted> {
  // The week as Codex reports it now: the session files miss an early reset until a turn runs after it.
  const week = [limits?.primary, limits?.secondary].find(w => (w?.windowDurationMins ?? 0) > 1440 && w?.resetsAt)
  const command =
    process.env.CODEX_BRIDGE_ADMIT ?? `${quote(process.execPath)} ${quote(join(homedir(), '.claude/skills/orchestrate/scripts/budget.ts'))} --codex --admit`
  const args = [
    ...(model ? ['--model', model] : []),
    '--role',
    role ?? 'none',
    ...(thread ? ['--thread', thread] : []),
    ...(reserve > 0 ? ['--reserve', reserve.toFixed(2)] : []),
    ...(week ? ['--week', `${week.usedPercent},${week.resetsAt},${week.windowDurationMins}`] : []),
  ]
    .map(quote)
    .join(' ')
  try {
    const child = Bun.spawn([process.env.SHELL || '/bin/sh', '-lc', `${command} ${args}`], { stdout: 'pipe', stderr: 'ignore', timeout: ADMIT_MS })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    const line = out.trim().split('\n').pop() ?? ''
    // A missing script exits 1 too: only its own answer holds a thread.
    if (code === 0 && line.startsWith('admit: ')) return { ok: true, line }
    if (code === 1 && line.startsWith('hold: ')) return { ok: false, line }
    return { line: child.signalCode ? `no answer in ${ADMIT_MS / 1e3} s` : line || `exit ${code}` }
  } catch (error) {
    return { line: (error as Error).message }
  }
}

/** The hard gates and the even line of ./budget.ts for the usage now, with the settings file's overrides. */
export function gates(limits: Budget.Limits | null, now: number): Budget.Budget {
  let config: Budget.Config = DEFAULTS
  try {
    config = { ...DEFAULTS, ...JSON.parse(readFileSync(BUDGET, 'utf8')).codex }
  } catch {
    // No settings file: the defaults.
  }
  return budget(limits, now, config)
}

/**
 * Whether one more turn of `thread` waits, why and until when. `reserve` (%/h)
 * is the cost of the turns just started; a turn that may start comes back
 * with the cost its admission says it adds.
 */
/** From Friday to Saturday sunset (the sabbath mod's hours) no turn runs: a running one stops, and all wait. */
export function paused(now: number): Hold | undefined {
  const s = sabbath(now)
  return s.on ? { why: `the Sabbath, until ${local(s.end)} (sunset, Knowlton, QC)`, opensAt: s.end } : undefined
}

export async function decide(thread: Asking, limits: Budget.Limits | null, reserve: number, now: number): Promise<{ hold?: Hold; admitted?: Admitted; adds?: number }> {
  const pause = paused(now)
  if (pause) return { hold: pause }
  const g = gates(limits, now)
  if (!g.send.ok) return { hold: { why: g.send.reason!, opensAt: g.send.until } }
  // A latched turn is already counted in `turns`: it continues the thread only past its first.
  const continues = thread.turns > (thread.status === 'queued' ? 1 : 0)
  const admitted = await admission(thread.model || undefined, thread.role, continues ? thread.id : undefined, reserve, limits)
  if (admitted.ok === false) {
    const at = OPENS.exec(admitted.line)
    const why = admitted.line.replace(/^hold: /, '').replace(OPENS, '')
    return { admitted, hold: { why, opensAt: at ? Date.parse(`${at[1]}T${at[2]}:00Z`) : undefined } }
  }
  // Unmeasured, the even line holds a new thread; a next turn goes on past it (./budget.ts).
  if (admitted.ok === undefined && !continues && !g.start.ok) return { admitted, hold: { why: g.start.reason!, opensAt: g.start.until } }
  const adds = /\(\+([\d.]+) %\/h\)/.exec(admitted.line)?.[1]
  return { admitted, adds: adds ? Number(adds) : undefined }
}

/** A latched turn that waited past the patience: it goes first, and holds the turns behind it. */
export const starving = (t: Thread, now: number) => now - Math.max(t.queuedAt ?? now, t.notBefore ?? 0) > PATIENCE_MS

/** The latched turns in the order they start: a starving one, then next turns before first ones, then the oldest. */
export const order = (queued: readonly Thread[], now: number) =>
  [...queued].sort(
    (a, b) => Number(starving(b, now)) - Number(starving(a, now)) || Number(a.turns === 1) - Number(b.turns === 1) || (a.queuedAt ?? 0) - (b.queuedAt ?? 0),
  )

/** Why a new turn waits behind a starving latched turn. */
export const behind = (first: Thread): Hold => ({ why: `a turn latched past ${PATIENCE_MIN} min goes first (${first.held})`, opensAt: first.opensAt })

/** Whether a new thread's first turn opens too late to wait for: then no thread is made, and its role moves to Claude now. */
export const refuses = (hold: Hold | undefined, now: number) => !!hold?.opensAt && hold.opensAt > now + PATIENCE_MS

/** Why a turn ended, from its end as Codex reports it and whether its caller interrupted it. */
export function cause(status: 'idle' | 'interrupted' | 'failed', error: string | undefined, interrupting: Thread['interrupting']): Cause {
  if (status === 'idle') return 'completed'
  if (status === 'interrupted' && interrupting === 'sabbath') return 'sabbath'
  if (status === 'interrupted' && interrupting) return 'interrupted-by-caller'
  return /at capacity/i.test(error ?? '') ? 'capacity' : 'error'
}

/** The next turn the bridge sends after a turn the infrastructure ended. */
export const resumePrompt = (cause: Cause) =>
  `Your last turn ended on ${ENDED_ON[cause] ?? cause}, not on your work. Continue the same task from where you are. Background jobs started in that turn no longer run; restart any you need.`

/** The resume after a turn that ended on `cause`, `tries` resumes in; undefined to leave the thread to its owner. */
export function resume(cause: Cause, tries: number, now = Date.now()): { prompt: string; why: string; waitMs: number } | undefined {
  // After the Sabbath, however many resumes came before.
  if (cause === 'sabbath') return { prompt: resumePrompt(cause), why: 'resume after the Sabbath', waitMs: Math.max(0, (paused(now)?.opensAt ?? now) - now) }
  if (!ENDED_ON[cause] || tries >= BACKOFF_MIN.length) return undefined
  return {
    prompt: resumePrompt(cause),
    why: `resume ${tries + 1} of ${BACKOFF_MIN.length}: the last turn ended on ${ENDED_ON[cause]}`,
    waitMs: BACKOFF_MIN[tries]! * 60e3,
  }
}

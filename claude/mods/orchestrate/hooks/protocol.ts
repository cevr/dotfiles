// What the mod reads from baton, and the commands a baton seat may not run.
// baton (~/Developer/personal/baton) owns the protocol; these are pure
// functions over its JSON so the hooks stay thin.

/** One line of `baton whoami --json`: this pane's place in a live run. */
export type Identity = { run: string; role: 'orch' | 'impl' | 'rev' | 'ver'; track: string }

/** One line of `baton status --json`. */
export type RunView = {
  run: string
  tracks: TrackView[]
  undelivered: { ref: number; to: string; state: string; failure: string }[]
}
export type TrackView = {
  track: string
  unit: string
  step: string
  holder: string
  round: number
  failures: number
  since: number
  agents: { role: string; name: string; status: string }[]
}

const parse = <A>(stdout: string): A[] => {
  try {
    const value = JSON.parse(stdout)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}
export const parseIdentity = (stdout: string): Identity | undefined => parse<Identity>(stdout)[0]
export const parseRuns = (stdout: string): RunView[] => parse<RunView>(stdout)

const POLL = 'orchestrate: no polling. End your turn; the next baton message wakes you.'

/** A commit that skips the hook reaches main ungated: hymn's track work and 13 film commits did. */
const HOOK_BYPASS = /(--no-verify\b|\b(LEFTHOOK|HUSKY)=0\b)/

/**
 * Refuses, in a baton seat: skipping the commit hook; polling; and a
 * hand-written herdr message to an agent of the run, since baton routes and
 * records every message: the seat passes (`baton pass`, `baton ask`) or the
 * orchestrator tells (`baton tell`).
 */
export const checkCommand = (command: string, me: Identity): { deny: string } | undefined => {
  if (HOOK_BYPASS.test(command))
    return { deny: 'orchestrate: every commit passes the hook; order the steps so each passes, or make them one commit.' }
  if (/\bherdr\s+agent\s+wait\b/.test(command)) return { deny: POLL }
  const sleeps = [...command.matchAll(/\bsleep\s+(\d+)/g)].map(m => Number(m[1]))
  if (sleeps.some(s => s >= 10) || /\b(until|while)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/.test(command))
    return { deny: POLL }
  for (const m of command.matchAll(/\bherdr\s+agent\s+prompt\s+(\S+)/g)) {
    const target = m[1]!.replace(/^["']|["']$/g, '')
    if (!target.startsWith(`${me.run}-`)) continue
    return {
      deny:
        me.role === 'orch'
          ? 'orchestrate: message a track agent with `baton tell <unit> <role> "<text>"`, so the log records it.'
          : 'orchestrate: end your step with `baton pass <file> [--verdict …]`, or ask with `baton ask <blocked.md>`; baton routes the message.',
    }
  }
  return undefined
}

/** The status line: `hymn: 2 tracks · 1 for you · 1 undelivered`. */
export const summary = (run: RunView | undefined): string | undefined => {
  if (!run || run.tracks.length === 0) return undefined
  const n = run.tracks.length
  const mine = run.tracks.filter(t => t.holder === 'orch').length
  const owed = run.undelivered.length
  return (
    `${run.run}: ${n} track${n === 1 ? '' : 's'}` +
    (mine ? ` · ${mine} for you` : '') +
    (owed ? ` · ${owed} undelivered` : '')
  )
}

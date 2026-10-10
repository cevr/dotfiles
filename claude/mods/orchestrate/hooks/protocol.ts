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

/**
 * architecture-loop's safety.md, as checks: each command shape that ran a
 * destructive string or slipped past the hook in a loop, with what to do
 * instead. In gent (2026-09-23) a heredoc of probe text ran `rm -rf ~`.
 */
const UNSAFE: readonly [RegExp, string][] = [
  [/(^|[^<])<<-?\s*['"]?[A-Za-z_]/, 'create or edit files with the Write and Edit tools, not a shell heredoc'],
  [/\bpython3?\s+(-c\b|-\s*($|[<|]))/m, 'create or edit files with the Write and Edit tools; read JSON with jq, not inline python'],
  [/\bbun\s+(-e|--eval)\b/, 'put the script in a file written with the Write tool and run `bun <file>`'],
  [/(^|[;&|(]|\bxargs|\bsudo)\s*rm\s+-[a-zA-Z]*[rR]/m, 'delete with `trash <path>`'],
  [/\bgit\s+stash\b/, 'the stash is shared across workspaces; read old code with `git show <commit>:<path>`'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/, 'leave history and the tree as they are; undo with a new commit, or `git restore --staged <file>` to unstage'],
  [/\bgit\s+push\b[^\n;&|]*\s(-f\b|--force\b)/, 'push without force; integration is a fast-forward of the reviewed head'],
  [/(--no-verify\b|\b(LEFTHOOK|HUSKY)=0\b)/, 'every commit passes the hook; order the steps so each passes, or make them one commit'],
]

/**
 * Refuses, in a baton seat: the commands safety.md bans; polling; and a
 * hand-written herdr message to an agent of the run, since baton routes and
 * records every message: the seat passes (`baton pass`, `baton ask`) or the
 * orchestrator tells (`baton tell`).
 */
export const checkCommand = (command: string, me: Identity): { deny: string } | undefined => {
  for (const [shape, instead] of UNSAFE)
    if (shape.test(command)) return { deny: `orchestrate (safety.md): ${instead}.` }
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

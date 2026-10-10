// The orchestrate protocol (skills/orchestrate/protocol.md) as pure functions:
// who a herdr agent is by its name, which shell commands break the protocol,
// and whose turn a track is by the files in its unit folder.

export type Role =
  | { kind: 'orch'; run: string }
  | { kind: 'impl' | 'rev' | 'ver'; run: string; track: string }

/** `<run>-orch`, or `<run>-<unit>-impl|rev|ver`; the run slug has no dash. */
export const roleOf = (name: string | null | undefined): Role | undefined => {
  if (!name) return undefined
  const orch = /^([a-z][a-z0-9]{0,7})-orch$/.exec(name)
  if (orch) return { kind: 'orch', run: orch[1]! }
  const worker = /^(([a-z][a-z0-9]{0,7})-[a-z0-9-]+)-(impl|rev|ver)$/.exec(name)
  if (worker) return { kind: worker[3] as 'impl' | 'rev' | 'ver', run: worker[2]!, track: worker[1]! }
  return undefined
}

const POLL = 'orchestrate: no polling. End your turn; the next herdr message wakes you.'

export type Handoff = { target: string; message: string; path: string }
export type CommandCheck = { deny: string } | { handoffs: Handoff[] }

const HANDOFF = /herdr\s+agent\s+prompt\s+(\S+)\s+(["'])([\s\S]*?)\2/g

/** The routes protocol.md allows a worker's message to take: kind → target suffix. */
const ROUTES: readonly [RegExp, (run: string, track: string) => string][] = [
  [/^Round \d+ ready$/, (_, t) => `${t}-rev`],
  [/^Round \d+ findings$/, (_, t) => `${t}-impl`],
  [/^Round \d+ verify$/, (_, t) => `${t}-ver`],
  [/^Round \d+ verify failed$/, (_, t) => `${t}-impl`],
  [/^(accepted|blocked|stuck)$/, r => `${r}-orch`],
]

/**
 * Refuses polling in any track session, and a worker's handoff that is not
 * one of protocol.md's messages, goes to the wrong agent, or waits. Returns
 * the handoffs found so the caller can check that each named file exists.
 */
export const checkCommand = (command: string, role: Role): CommandCheck => {
  if (/\bherdr\s+agent\s+wait\b/.test(command)) return { deny: POLL }
  if (/\bherdr\s+agent\s+prompt\b[^\n]*\s--(wait|until)\b/.test(command))
    return { deny: 'orchestrate: hand off without --wait or --until, then end your turn.' }
  const sleeps = [...command.matchAll(/\bsleep\s+(\d+)/g)].map(m => Number(m[1]))
  if (sleeps.some(s => s >= 10) || /\b(until|while)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/.test(command))
    return { deny: POLL }

  const handoffs: Handoff[] = []
  for (const m of command.matchAll(HANDOFF)) {
    const target = m[1]!
    const message = m[3]!
    if (role.kind === 'orch') continue
    const parsed = /^\[([a-z0-9-]+)\] ([^:]+): (\S+)$/.exec(message.trim())
    const route = parsed && ROUTES.find(([kind]) => kind.test(parsed[2]!))
    if (!parsed || parsed[1] !== role.track || !route)
      return {
        deny:
          `orchestrate: a handoff is one line, "[${role.track}] <kind>: <file path>", ` +
          'with <kind> one of: Round N ready, Round N findings, Round N verify, ' +
          'Round N verify failed, accepted, blocked, stuck (protocol.md → Messages).',
      }
    const expected = route[1](role.run, role.track)
    if (target !== expected)
      return { deny: `orchestrate: "${parsed[2]}" goes to ${expected}, not ${target}.` }
    handoffs.push({ target, message: message.trim(), path: parsed[3]! })
  }
  return { handoffs }
}

export type Next = 'impl' | 'rev' | 'ver' | 'orch'
export type TrackState = {
  round: number
  next: Next
  /** What the track is doing, for the pane: `r2 in review`, `accepted`. */
  label: string
  /** The newest protocol file's mtime: when the current step began. */
  since: number
}

export type UnitFile = { name: string; mtimeMs: number; firstLine?: string }

/**
 * Whose turn the track is, from its unit folder: the newest round's request,
 * findings and verify files (verdict on the first line) and `blocked.md`.
 */
export const deriveTrack = (files: readonly UnitFile[], hasVerifier: boolean): TrackState => {
  const by = new Map(files.map(f => [f.name, f]))
  const rounds = files
    .map(f => /^round-(\d+)-request\.md$/.exec(f.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => Number(m[1]))
  const round = rounds.length ? Math.max(...rounds) : 0
  const spec = by.get('spec.md')?.mtimeMs ?? 0
  if (round === 0) return { round, next: 'impl', label: 'building r1', since: spec }

  const request = by.get(`round-${round}-request.md`)!
  const findings = by.get(`round-${round}-findings.md`)
  const verify = by.get(`round-${round}-verify.md`)
  const blocked = by.get('blocked.md')
  const newest = Math.max(request.mtimeMs, findings?.mtimeMs ?? 0, verify?.mtimeMs ?? 0)
  if (blocked && blocked.mtimeMs > newest)
    return { round, next: 'orch', label: 'blocked', since: blocked.mtimeMs }

  if (!findings) return { round, next: 'rev', label: `r${round} in review`, since: request.mtimeMs }
  const verdict = findings.firstLine ?? ''
  if (/STUCK/.test(verdict)) return { round, next: 'orch', label: 'stuck', since: findings.mtimeMs }
  if (!/ACCEPTED/.test(verdict))
    return { round, next: 'impl', label: `r${round} fixing`, since: findings.mtimeMs }
  if (!hasVerifier) return { round, next: 'orch', label: 'accepted', since: findings.mtimeMs }

  if (!verify) return { round, next: 'ver', label: `r${round} verifying`, since: findings.mtimeMs }
  const verified = verify.firstLine ?? ''
  if (/STUCK/.test(verified)) return { round, next: 'orch', label: 'stuck', since: verify.mtimeMs }
  if (/PASS/.test(verified)) return { round, next: 'orch', label: 'accepted', since: verify.mtimeMs }
  return { round, next: 'impl', label: `r${round} fixing (verify)`, since: verify.mtimeMs }
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export const STALL_MS = 10 * 60_000
export const DIALOG_MS = 2 * 60_000
export const UNREPORTED_MS = 3 * 60_000

/**
 * Why the track needs the orchestrator now, or undefined while it moves:
 * the agent whose turn it is is gone, sits at a dialog, or the whole track
 * has been quiet past STALL_MS; or a final file exists that no message
 * reported.
 */
export const stallOf = (input: {
  state: TrackState
  agents: Partial<Record<'impl' | 'rev' | 'ver', AgentStatus>>
  quietSince: number | undefined
  blockedSince: number | undefined
  reportedAt: number | undefined
  now: number
}): string | undefined => {
  const { state, agents, quietSince, blockedSince, reportedAt, now } = input
  if (state.next === 'orch') {
    const reported = reportedAt !== undefined && reportedAt >= state.since
    return !reported && now - state.since >= UNREPORTED_MS
      ? `${state.label} on file, but no message reached you`
      : undefined
  }
  if (agents[state.next] === undefined) return `the ${state.next} agent is gone while the next step is its`
  if (blockedSince !== undefined && now - blockedSince >= DIALOG_MS) return 'an agent sits at a dialog'
  if (quietSince !== undefined && now - quietSince >= STALL_MS)
    return `every agent idle ${Math.round((now - quietSince) / 60_000)}m while the next step is the ${state.next}'s`
  return undefined
}

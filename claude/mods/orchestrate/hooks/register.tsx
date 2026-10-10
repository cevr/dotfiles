import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrackView } from '../types'
import {
  type AgentStatus,
  type Role,
  type UnitFile,
  checkCommand,
  deriveTrack,
  roleOf,
  stallOf,
} from './protocol'

const PANE = 'tracks'
const TICK_MS = 60_000
const tracks = atom({ plugin: 'orchestrate', key: 'tracks' } as const, [])

type Workers = Partial<Record<'impl' | 'rev' | 'ver', AgentStatus>>

async function herdr($: EngineInterface, args: string[]): Promise<any> {
  const ran = await $.process.run(['herdr', ...args], { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) return undefined
  try {
    return JSON.parse(ran.stdout)
  } catch {
    return undefined
  }
}

// Module state: it starts over on a reload, which only delays a stall alert.
let role: { at: number; value: Role | undefined } | undefined
let runDir: { run: string; dir: string } | undefined
const quietSince = new Map<string, number>()
const blockedSince = new Map<string, number>()
const reportedAt = new Map<string, number>()
const alerted = new Set<string>()

/** This session's role, from the name herdr gives its pane's agent. */
async function roleNow($: EngineInterface): Promise<Role | undefined> {
  const now = await $.clock.now()
  if (role && now - role.at < 15_000) return role.value
  const pane = await $.env.get('HERDR_PANE_ID')
  const got = pane ? await herdr($, ['agent', 'get', pane]) : undefined
  role = { at: now, value: roleOf(got?.result?.agent?.name) }
  return role.value
}

/** `~/.cache/orchestrate/<repo>/<run>`, whichever repo holds the run. */
async function dirOf($: EngineInterface, run: string): Promise<string | undefined> {
  if (runDir?.run === run) return runDir.dir
  const base = `${await $.env.get('HOME')}/.cache/orchestrate`
  if (!(await $.fs.exists(base))) return undefined
  for (const repo of await $.fs.list(base)) {
    const dir = `${base}/${repo.name}/${run}`
    if (repo.kind === 'dir' && (await $.fs.exists(dir))) {
      runDir = { run, dir }
      return dir
    }
  }
  return undefined
}

async function unitFiles($: EngineInterface, dir: string): Promise<UnitFile[]> {
  if (!(await $.fs.exists(dir))) return []
  const entries = (await $.fs.list(dir)).filter(f => f.kind === 'file')
  return Promise.all(
    entries.map(async f => ({
      name: f.name,
      mtimeMs: f.mtimeMs,
      firstLine: /^round-\d+-(findings|verify)\.md$/.test(f.name)
        ? (await $.fs.read(`${dir}/${f.name}`)).split('\n', 1)[0]
        : undefined,
    })),
  )
}

/** One watchdog pass: herdr's agent list plus the run dir, no model call. */
async function tick($: EngineInterface) {
  const me = await roleNow($)
  if (me?.kind !== 'orch') return
  const listed = await herdr($, ['agent', 'list'])
  const now = await $.clock.now()
  const groups = new Map<string, Workers>()
  for (const agent of listed?.result?.agents ?? []) {
    const r = roleOf(agent.name)
    if (!r || r.kind === 'orch' || r.run !== me.run) continue
    const workers = groups.get(r.track) ?? {}
    workers[r.kind] = agent.agent_status as AgentStatus
    groups.set(r.track, workers)
  }
  const dir = await dirOf($, me.run)
  const views: TrackView[] = []
  for (const [track, workers] of groups) {
    const unit = track.slice(me.run.length + 1)
    const state = deriveTrack(dir ? await unitFiles($, `${dir}/${unit}`) : [], workers.ver !== undefined)
    const statuses = Object.values(workers)
    if (statuses.includes('working')) quietSince.delete(track)
    else if (!quietSince.has(track)) quietSince.set(track, now)
    if (!statuses.includes('blocked')) blockedSince.delete(track)
    else if (!blockedSince.has(track)) blockedSince.set(track, now)
    const stall = stallOf({
      state,
      agents: workers,
      quietSince: quietSince.get(track),
      blockedSince: blockedSince.get(track),
      reportedAt: reportedAt.get(track),
      now,
    })
    views.push({ track, round: state.round, label: state.label, next: state.next, workers, stall })
    const key = `${track}|${state.label}|${state.since}`
    if (stall && !alerted.has(key)) {
      alerted.add(key)
      void $.prompt.submit({
        text:
          `[watchdog] ${track}: ${stall}. Step: ${state.label}` +
          (dir ? `; unit folder ${dir}/${unit}` : '') +
          ". Follow the orchestrate skill's stall check.",
      }).catch(() => alerted.delete(key)) // not delivered: the next tick retries
    }
  }
  await update($, tracks, () => views)
  const waiting = views.filter(v => v.next === 'orch').length
  const stalled = views.filter(v => v.stall).length
  $.ui.status(
    views.length
      ? `${me.run}: ${views.length} track${views.length === 1 ? '' : 's'}` +
          (waiting ? ` · ${waiting} for you` : '') +
          (stalled ? ` · ${stalled} stalled` : '')
      : undefined,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracks',
      description: 'Show the orchestrate tracks: round, whose turn, agent states',
    })
    if (await $.env.get('HERDR_PANE_ID')) $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'tracks' }, async $ => {
    await tick($)
    await $.ui.open({ id: PANE, title: 'Tracks' })
    return { text: 'Tracks pane opened.' }
  })

  // A worker's final message reached the orchestrator: the track is reported.
  on('prompt.submit', async ($, e, next) => {
    const m = /^\[([a-z0-9-]+)\] (accepted|blocked|stuck):/.exec(e.text.trim())
    if (m) reportedAt.set(m[1]!, await $.clock.now())
    return next(e)
  })

  // The protocol, enforced: no polling, and a worker's handoff is a known
  // message, to the right agent, naming a file that exists.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const me = await roleNow($)
    if (!me) return next(e)
    const check = checkCommand(e.command, me)
    if ('deny' in check) return { deny: check.deny }
    const home = (await $.env.get('HOME')) ?? '~'
    for (const handoff of check.handoffs) {
      const path = handoff.path.replace(/^(~|\$HOME)(?=\/)/, home)
      if (!(await $.fs.exists(path)))
        return { deny: `orchestrate: ${handoff.path} does not exist; write it, then hand off.` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const views = await read($, tracks)
    const width = Math.max(5, ...views.map(v => v.track.length))
    return (
      <Box flexDirection="column">
        {views.length === 0 && <Text dimColor>No tracks: this pane fills in an orchestrator session (`&lt;run&gt;-orch`).</Text>}
        {views.map(v => (
          <Box flexDirection="column">
            <Text bold={v.next === 'orch'} color={v.stall ? 'warning' : undefined}>
              {v.track.padEnd(width)}  r{v.round}  {v.label}  → {v.next}
            </Text>
            <Text dimColor>
              {'  '}
              {(['impl', 'rev', 'ver'] as const)
                .filter(k => v.workers[k] !== undefined)
                .map(k => `${k} ${v.workers[k]}`)
                .join(' · ')}
              {v.stall ? `  ⚠ ${v.stall}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}

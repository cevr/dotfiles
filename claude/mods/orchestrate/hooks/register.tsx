import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { type Identity, checkCommand, parseIdentity, parseRuns, summary } from './protocol'

const PANE = 'tracks'
const TICK_MS = 60_000
const tracks = atom({ plugin: 'orchestrate', key: 'tracks' } as const, [])

async function baton($: EngineInterface, args: string[]): Promise<string | undefined> {
  const ran = await $.process.run(['baton', ...args], { timeoutMs: 30_000 }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

// Module state: it starts over on a reload, which costs one extra whoami.
let identity: { at: number; value: Identity | undefined } | undefined

/** This pane's place in a live baton run, cached for 15 seconds. */
async function whoami($: EngineInterface): Promise<Identity | undefined> {
  const now = await $.clock.now()
  if (identity && now - identity.at < 15_000) return identity.value
  const out = await baton($, ['whoami', '--json'])
  identity = { at: now, value: out === undefined ? undefined : parseIdentity(out) }
  return identity.value
}

/** Reads `baton status` into the pane and the status line. */
async function refresh($: EngineInterface, me: Identity) {
  const run = parseRuns((await baton($, ['status', '--json'])) ?? '[]').find(r => r.run === me.run)
  await update($, tracks, () => run?.tracks ?? [])
  $.ui.status(summary(run))
}

/** One watchdog pass in the orchestrator's session: baton records, alerts and delivers. */
async function tick($: EngineInterface) {
  const me = await whoami($)
  if (me?.role !== 'orch') return
  await baton($, ['tick'])
  await refresh($, me)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracks',
      description: 'Show the baton tracks: round, step, who holds the baton, agent states',
    })
    if (await $.env.get('HERDR_PANE_ID')) $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'tracks' }, async $ => {
    const me = await whoami($)
    if (me) await refresh($, me)
    await $.ui.open({ id: PANE, title: 'Tracks' })
    return { text: 'Tracks pane opened.' }
  })

  // In a baton seat: no polling, and messages go through baton.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const me = await whoami($)
    const check = me && checkCommand(e.command, me)
    if (check) return check
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const views = await read($, tracks)
    const width = Math.max(5, ...views.map(v => v.track.length))
    return (
      <Box flexDirection="column">
        {views.length === 0 && <Text dimColor>No tracks: this pane fills in a baton orchestrator's session.</Text>}
        {views.map(v => (
          <Box flexDirection="column">
            <Text bold={v.holder === 'orch'}>
              {v.track.padEnd(width)}  r{v.round}  {v.step}  → {v.holder}
            </Text>
            <Text dimColor>
              {'  '}
              {v.agents.map(a => `${a.role} ${a.status}`).join(' · ')}
              {v.failures ? `  ${v.failures} failed` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}

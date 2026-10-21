import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Snapshot } from '../types'
import { parseBudget, parseRun, statusLine } from './parse'

// The account pool and the orchestrate runs of the session's repo, on the
// status line every minute, and in full in the /pool pane.

const PANE = 'status'
const EVERY_MS = 60e3
const SCRIPTS = '"$HOME/.claude/skills/orchestrate/scripts"'
const snapshot = atom({ plugin: 'status', key: 'snapshot' } as const, { at: 0, runs: [] } as Snapshot)

const sh = (script: string, ...args: string[]) => ['sh', '-c', script, 'sh', ...args]

// One refresh at a time: a caller that arrives mid-refresh waits on it.
let inFlight: Promise<void> | undefined

function refresh($: EngineInterface): Promise<void> {
  inFlight ??= load($).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function load($: EngineInterface) {
  try {
    const budget = await $.process.run(sh(`bun ${SCRIPTS}/budget.ts`), { timeoutMs: 20e3 })
    // A run dir sits in the checkout that holds the run's main: for a git
    // worktree that is the main checkout, found through the common git dir.
    const common = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const top = common.exitCode === 0 ? common.stdout.trim().replace(/\/\.git$/, '') : ''
    const runs: Run[] = []
    if (top) {
      const dirs = await $.process.run(sh('ls -1d "$1"/tmp/orchestrate/*/ 2>/dev/null', top))
      for (const dir of dirs.stdout.split('\n').filter(Boolean)) {
        const name = dir.replace(/\/$/, '').split('/').pop() ?? dir
        const status = await $.process.run(sh(`bun ${SCRIPTS}/status.ts "$1"`, dir), { timeoutMs: 20e3 })
        if (status.exitCode === 0) runs.push(parseRun(name, status.stdout))
      }
    }
    const pool = parseBudget(budget.stdout)
    const next: Snapshot = {
      at: await $.clock.now(),
      pool,
      runs,
      error: pool ? undefined : budget.stderr.trim().split('\n').at(-1) || 'budget.ts gave no total',
    }
    await update($, snapshot, () => next)
    $.ui.status(statusLine(pool, runs))
  } catch (error) {
    $.ui.log(`status: refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pool',
      description: 'Show the account pool and the orchestrate runs in a pane',
    })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'pool' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Pool and runs' })
    return { text: 'Pool pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { at, pool, runs, error } = await read($, snapshot)
    const time = at ? new Date(at).toISOString().slice(11, 16) + 'Z' : 'not yet'

    return (
      <Box flexDirection="column">
        <Text bold>Pool</Text>
        {pool ? (
          <Text>
            {pool.agents}/{pool.cap} agents · {pool.megaWeighted} MW in 5 h
          </Text>
        ) : (
          <Text dimColor>{error ?? 'Reading the pool.'}</Text>
        )}
        {pool?.hosts.map(host => <Text dimColor>{host}</Text>)}
        <Text> </Text>
        <Text bold>Orchestrate runs</Text>
        {runs.length === 0 && <Text dimColor>No run dir in this repo.</Text>}
        {runs.map(run => (
          <Box flexDirection="column">
            <Text>
              {run.name}: {run.units.length === 0 ? 'nothing active' : `${run.units.length} active`}
            </Text>
            {run.units.map(unit => (
              <Text dimColor>
                {'  '}
                {unit.unit} {unit.state} r{unit.round} since {unit.since}
              </Text>
            ))}
          </Box>
        ))}
        <Text> </Text>
        <Text dimColor>Updated {time}; refreshes every minute.</Text>
      </Box>
    )
  })
}

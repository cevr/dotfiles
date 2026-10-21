import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, Run, Sample, Snapshot } from '../types'
import { compaction, tune } from './compact'
import { duration, fiveHourPerHour, isNear, outlook, parseAccounts, parseBudget, parseRun, statusLine } from './parse'

// Whether the Claude account pool lasts at the current pace, every minute: a
// status line (drawn as a warning) while a rate limit is less than a day away,
// else dim at the end of the hint under the prompt. The accounts, agents and orchestrate runs
// are in the /pool pane.
// Each refresh also rotates the accounts into weekly reset order.
// Each agent kind compacts at the window the burn says it costs least at (compact.ts).

const PANE = 'status'
const EVERY_MS = 60e3
const SAMPLES_MS = 60 * 60e3
const SCRIPTS = '"$HOME/.claude/skills/orchestrate/scripts"'
const snapshot = atom(
  { plugin: 'status', key: 'snapshot' } as const,
  { at: 0, accounts: [], samples: [], runs: [] } as Snapshot,
)

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
    const now = await $.clock.now()
    const before = await read($, snapshot)
    const quota = await $.process.run(sh('PATH="$HOME/.bun/bin:$PATH" teamclaude status --json'), {
      timeoutMs: 10e3,
    })
    let accounts: Account[] = []
    let error: string | undefined
    try {
      accounts = quota.exitCode === 0 ? parseAccounts(quota.stdout) : []
      if (quota.exitCode !== 0) error = 'teamclaude status failed'
    } catch {
      error = 'teamclaude status gave no JSON'
    }
    const samples: Sample[] = [
      ...before.samples.filter(sample => sample.at > now - SAMPLES_MS),
      ...(accounts.length > 0 ? [{ at: now, used5h: accounts.map(a => a.used5h) }] : []),
    ]
    const view = accounts.length > 0 ? outlook(accounts, fiveHourPerHour(samples, now), now) : undefined

    // --rotate keeps teamclaude's priorities in weekly reset order, so the
    // account whose quota expires first serves first.
    const budget = await $.process.run(sh(`bun ${SCRIPTS}/budget.ts --rotate`), { timeoutMs: 20e3 })
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
    const next: Snapshot = {
      at: now,
      accounts,
      samples,
      outlook: view,
      pool: parseBudget(budget.stdout),
      runs,
      error,
    }
    await update($, snapshot, () => next)
    $.ui.status(
      isNear(view, now) ? statusLine(view, now) : !view && error ? `limits unknown: ${error}` : undefined,
    )
  } catch (error) {
    $.ui.log(`status: refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`
const resetIn = (at: number | undefined, now: number) => (at && at > now ? `resets in ${duration(at - now)}` : '')

export const register: Register = on => {
  compaction(on)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pool',
      description: 'Show the rate-limit outlook, the accounts, agents and orchestrate runs; `project <name>` names this session\'s project',
    })
    // The budget counts each session's cost against its project, named after
    // its herdr workspace unless `/pool project <name>` says otherwise.
    void $.process.run(sh(`PATH="$HOME/.bun/bin:$PATH" bun ${SCRIPTS}/budget/label.ts`), { timeoutMs: 10e3 })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    tune($)
    return started
  })

  on('command.run', { command: 'pool' }, async ($, e) => {
    const project = e.args.match(/^project\s+(.+)$/)?.[1]?.trim()
    if (project) {
      const set = await $.process.run(sh(`PATH="$HOME/.bun/bin:$PATH" bun ${SCRIPTS}/budget/label.ts --set "$1"`, project), {
        timeoutMs: 10e3,
      })
      return { text: set.exitCode === 0 ? `This session's project is ${set.stdout.trim() || project}.` : 'Could not set the project.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Rate limits' })
    return { text: 'Rate limits pane opened.' }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { at, outlook: view } = await read($, snapshot)
    const calm = view && !isNear(view, at) ? statusLine(view, at) : undefined
    return next(calm ? { ...e, props: { ...e.props, tail: ` · ${calm}` } } : e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { at, accounts, outlook: view, pool, runs, error } = await read($, snapshot)
    const time = at ? new Date(at).toISOString().slice(11, 16) + 'Z' : 'not yet'

    return (
      <Box flexDirection="column">
        <Text bold>{statusLine(view, at) ?? error ?? 'Reading the accounts.'}</Text>
        {view && (
          <Text dimColor>
            Weekly burn {percent(view.weekPerHour)} of one account per hour; 5h burn{' '}
            {view.fiveHourPerHour === undefined ? 'measured after 10 minutes' : `${percent(view.fiveHourPerHour)} per hour`}.
          </Text>
        )}
        <Text> </Text>
        <Text bold>Accounts (use of each window)</Text>
        {accounts.map(account => (
          <Text dimColor={account.usedWeek >= 1}>
            {account.label} 5h {percent(account.used5h)} {resetIn(account.reset5h, at)} · week {percent(account.usedWeek)}{' '}
            {resetIn(account.resetWeek, at)}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Agents</Text>
        {pool ? (
          <Text>
            {pool.agents} running, cap {pool.cap}
          </Text>
        ) : (
          <Text dimColor>budget.ts gave no total.</Text>
        )}
        {pool?.pace && <Text>Week: {pool.pace}</Text>}
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

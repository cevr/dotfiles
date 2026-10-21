import { expect, test } from 'claude-code/testing'

import { fiveHourPerHour, isNear, outlook, parseAccounts, statusLine } from '../hooks/parse'

const HOUR = 3600e3
const NOW = Date.UTC(2026, 9, 21, 3, 30)

// Tonight's pool (2026-10-21 03:30Z): six accounts spent for the week, the
// seventh at 62% and burning, the first weekly reset 15h30m away.
const account = (name: string, used5h: number, used7d: number, resetWeekIn: number, perHour = 0) => ({
  name,
  email: `${name}@example.com`,
  disabled: false,
  quota: {
    unified5h: used5h,
    unified7d: used7d,
    unified5hReset: NOW + 2 * HOUR,
    unified7dReset: NOW + resetWeekIn * HOUR,
    forecast: { unified7d: { ratePerHour: perHour } },
  },
})
const TONIGHT = JSON.stringify({
  accounts: [
    account('one', 0, 1, 50),
    account('two', 0.03, 1, 82),
    account('three', 0, 1, 15.5),
    account('four', 0, 1, 34),
    account('five', 0, 1, 125),
    account('six', 0, 1, 72),
    account('seven', 0.43, 0.62, 22.6, 0.38 / 4.5),
  ],
})

const BUDGET = `host-a: 2 agents, 2 roots active in 10 min; 133 MW in 5 h
host-b: 3 agents, 1 roots active in 10 min; 37 MW in 5 h
weekly: burn 9.8%/h; pace 0.5%/h, weekly ceiling 1.3%/h, 5h ceiling 4.0%/h; over pace: a weekly limit comes before the next reset
budget: 5/8 agents, 170 MW in 5 h
`

const STATUS = `| Unit | State | Round | Since | Cause |
| ---- | ----- | ----- | ----- | ----- |
| android | done | 3 | 2026-10-18T02:51Z | android/round-3-request.md |
| census2 | implement | 3 | 2026-10-20T23:03Z | round-2-findings.md |
| reader1 | verify | 1 | 2026-10-20T22:40Z | round-1-findings.md |
`

const PANE = {
  plugin: 'status',
  component: 'Pane',
  requestId: 'status',
  props: {
    title: 'Rate limits',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ran = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const ok = (stdout: string) => ran(0, stdout)

test('the weekly pool runs out before the next reset', () => {
  const view = outlook(parseAccounts(TONIGHT), undefined, NOW)
  expect(statusLine(view, NOW)).toBe('rate limit in 4h30m, for 11h (weekly) · 1/7 accounts have quota')
})

test('a pool that lasts to the next reset is on track', () => {
  const accounts = parseAccounts(
    JSON.stringify({ accounts: [account('one', 0.2, 0.9, 2, 0.005), account('two', 0.1, 0.5, 100, 0.005)] }),
  )
  expect(statusLine(outlook(accounts, undefined, NOW), NOW)).toBe('no rate limit ahead · 2/2 accounts have quota')
})

test('the 5-hour burn comes from readings at least 10 minutes apart', () => {
  const samples = [
    { at: NOW - 20 * 60e3, used5h: [0.5, 0] },
    { at: NOW - 5 * 60e3, used5h: [0.6, 0] },
    { at: NOW, used5h: [0.7, 0.1] },
  ]
  // 0.2 + 0.1 in 20 minutes is 0.9 of an account per hour.
  expect(Math.round((fiveHourPerHour(samples, NOW) ?? 0) * 100)).toBe(90)
  expect(fiveHourPerHour(samples.slice(1), NOW)).toBeUndefined()

  // Two accounts with 5h left 0.3 + 0.9 = 1.2 at 0.9/h run out in 80m, before
  // their 5h windows reset at 2h.
  const accounts = parseAccounts(JSON.stringify({ accounts: [account('one', 0.7, 0.2, 100), account('two', 0.1, 0.2, 100)] }))
  expect(statusLine(outlook(accounts, 0.9, NOW), NOW)).toBe('rate limit in 1h20m, for 40m (5h) · 2/2 accounts have quota')
})

test('the status line and the pane show the outlook, accounts and active units', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    if (script.includes('teamclaude status')) return ok(TONIGHT)
    if (script.includes('budget.ts --rotate')) return ok(BUDGET)
    if (script.includes('rev-parse')) return ok('/repo/.git\n')
    if (script.includes('ls -1d')) return ok('/repo/tmp/orchestrate/hymnapp/\n')
    if (script.includes('status.ts')) return ok(STATUS)
    return ran(1, '', 'unexpected')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'pool',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(lines.at(-1)).toBe('rate limit in 4h30m, for 11h (weekly) · 1/7 accounts have quota')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^A7 / }))?.text).toBe('A7 5h 43% resets in 2h · week 62% resets in 22h36m')
  expect(await ui.find({ type: 'Text', text: /example\.com|seven/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /running, cap/ }))?.text).toBe('5 running, cap 8')
  expect((await ui.find({ type: 'Text', text: /^Week: / }))?.text).toBe(
    'Week: burn 9.8%/h; pace 0.5%/h, weekly ceiling 1.3%/h, 5h ceiling 4.0%/h; over pace: a weekly limit comes before the next reset',
  )
  expect(await ui.find({ type: 'Text', text: /^weekly: / })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^host-a/ }))?.text).toBe('host-a: 2 agents, 2 roots active in 10 min')
  expect((await ui.find({ type: 'Text', text: /census2/ }))?.text).toBe('  census2 implement r3 since 2026-10-20T23:03Z')
  expect(await ui.find({ type: 'Text', text: /android/ })).toBeUndefined()
  await ui.unmount()
})

test('`/pool project <name>` names the session\'s project', async ($, on) => {
  const runs: string[] = []
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    runs.push(script)
    if (script.includes('label.ts --set')) return ok('hymnal\n')
    return ran(1, '', 'unexpected')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(runs.some(script => script.includes('label.ts') && !script.includes('--set'))).toBe(true)
  const result = await $.command.run({
    command: 'pool',
    args: 'project hymnal',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(result).toMatchObject({ text: "This session's project is hymnal." })
  expect(runs.find(script => script.includes('--set'))).toContain('hymnal')
})

test('with no rate limit ahead, the outlook leaves the warning line for the prompt hint', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    if (script.includes('teamclaude status'))
      return ok(JSON.stringify({ accounts: [account('one', 0.2, 0.9, 2, 0.005), account('two', 0.1, 0.5, 100, 0.005)] }))
    return ran(1, '', 'unexpected')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's hint line.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.hint}${e.props.tail ?? ''}`}</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'pool',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(lines.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({
    plugin: 'status',
    component: 'PromptHint',
    surface: 'terminal',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  expect((await ui.find({ type: 'Text', text: /shortcuts/ }))?.text).toBe(
    '? for shortcuts · no rate limit ahead · 2/2 accounts have quota',
  )
  await ui.unmount()
})

test('only a rate limit less than a day away is near', () => {
  const accounts = parseAccounts(JSON.stringify({ accounts: [account('one', 0.2, 0.9, 2, 0.005)] }))
  const view = outlook(accounts, undefined, NOW)
  expect(isNear({ ...view, limitedAt: NOW + 4 * HOUR }, NOW)).toBe(true)
  expect(isNear({ ...view, limitedAt: NOW + 6 * 24 * HOUR }, NOW)).toBe(false)
  expect(isNear({ ...view, limitedAt: undefined }, NOW)).toBe(false)
})

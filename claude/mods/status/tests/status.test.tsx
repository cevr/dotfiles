import { expect, test } from 'claude-code/testing'

const BUDGET = `host-a: 2 agents, 2 roots active in 10 min; 133 MW in 5 h
host-b: 3 agents, 1 roots active in 10 min; 37 MW in 5 h
budget: 5/8 agents, 170 MW in 5 h
`

const STATUS = `| Unit | State | Round | Since | Cause |
| ---- | ----- | ----- | ----- | ----- |
| android | done | 3 | 2026-10-18T02:51Z | android/round-3-request.md |
| appbase | merged 27d0cc3ae | 2 | 2026-10-18T02:10Z | merge-appbase.log |
| census2 | implement | 3 | 2026-10-20T23:03Z | round-2-findings.md |
| reader1 | verify | 1 | 2026-10-20T22:40Z | round-1-findings.md |
`

const PANE = {
  plugin: 'status',
  component: 'Pane',
  requestId: 'status',
  props: {
    title: 'Pool and runs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ran = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const ok = (stdout: string) => ran(0, stdout)

test('the status line and the pane show the pool and the active units', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 20, 23, 10) }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    if (script.includes('budget.ts')) return ok(BUDGET)
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

  expect(lines.at(-1)).toBe('pool 5/8 · 170 MW/5h · hymnapp: 1 implement, 1 verify')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /agents ·/ }))?.text).toBe('5/8 agents · 170 MW in 5 h')
  expect((await ui.find({ type: 'Text', text: /hymnapp/ }))?.text).toBe('hymnapp: 2 active')
  expect((await ui.find({ type: 'Text', text: /census2/ }))?.text).toBe('  census2 implement r3 since 2026-10-20T23:03Z')
  expect(await ui.find({ type: 'Text', text: /android/ })).toBeUndefined()
  await ui.unmount()
})

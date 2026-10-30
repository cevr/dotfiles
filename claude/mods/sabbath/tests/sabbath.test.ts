import { expect, test, type TestBody } from 'claude-code/testing'

import { awake, awakeAfter, local, sabbath, sunset } from '../hooks/sabbath'

const MONTREAL = { lat: 45.5017, lon: -73.5673 }
const at = (iso: string) => Date.parse(iso)
// Within this of published sunset times.
const NEAR = 3 * 60e3

test('sunset falls on its own day, within minutes of the published time', () => {
  // Montreal: 2026-06-21 20:46 EDT, 2026-12-21 16:13 EST.
  expect(Math.abs(sunset(2026, 6, 21, MONTREAL) - at('2026-06-22T00:46:00Z'))).toBeLessThan(NEAR)
  expect(Math.abs(sunset(2026, 12, 21, MONTREAL) - at('2026-12-21T21:13:00Z'))).toBeLessThan(NEAR)
})

test('the Sabbath runs from Friday sunset to Saturday sunset in Knowlton', () => {
  const friday = sabbath(at('2026-10-30T14:30:00Z'))
  expect(friday.on).toBe(false)
  expect(local(friday.start)).toBe('Fri 17:41')
  expect(local(friday.end)).toBe('Sat 17:39')
  expect(sabbath(friday.start + 60e3).on).toBe(true)
  expect(sabbath(at('2026-10-31T12:00:00Z')).on).toBe(true)
  // Past Saturday's sunset, the next one is a week on, after the clocks change.
  const after = sabbath(friday.end + 60e3)
  expect(after.on).toBe(false)
  expect(local(after.start)).toBe('Fri 16:31')
})

test('the hours awake leave out each Sabbath, and awakeAfter inverts them', () => {
  const friday = sabbath(at('2026-10-30T14:30:00Z'))
  const week = 7 * 864e5
  // From Friday morning to the next Friday morning: one Sabbath out.
  const from = at('2026-10-30T14:30:00Z')
  expect(awake(from, from + week)).toBe(week - (friday.end - friday.start))
  // Inside the Sabbath, nothing passes.
  expect(awake(friday.start + 60e3, friday.end - 60e3)).toBe(0)
  // Two hours before sunset, three hours awake end one hour past Saturday's sunset.
  expect(awakeAfter(friday.start - 2 * 3600e3, 3 * 3600e3)).toBe(friday.end + 3600e3)
  expect(awake(from, awakeAfter(from, 50 * 3600e3))).toBe(50 * 3600e3)
})

// The codex mod's tool, which this mod's generated types name only once a session loads both.
type Call = Parameters<Parameters<TestBody>[0]['tool']['call']>[0]
const codexStart = { tool: 'mcp__codex__start', description: 'd', prompt: 'p' } as unknown as Call
// Lets the hooks' unawaited work run to its end: the mocks answer at once.
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

const SPAWN = { tool_use_id: 't1', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'opus', background: true, fork: false }

const mock = (on: Parameters<TestBody>[1], time: number) => {
  const status: (string | undefined)[] = []
  on('clock.now', () => ({ value: time }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }))
  on('tool.call', () => ({ result: 'ran' }))
  return status
}

test('during the Sabbath no agent work starts, and a running subagent is told to stop', async ($, on) => {
  const status = mock(on, at('2026-10-31T12:00:00Z'))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(status.at(-1)).toBe('Sabbath until Sat 17:39')

  expect(await $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor' })).toEqual({ deny: expect.stringContaining('Sabbath until Sat 17:39') })
  expect(await $.tool.call(codexStart)).toEqual({ deny: expect.stringContaining('No Codex turn') })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).toEqual({ deny: expect.stringContaining('Stop now') })
  // The main loop still answers the owner.
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toMatchObject({ result: 'ran' })
})

test('outside the Sabbath everything runs, and the status line is clear', async ($, on) => {
  const status = mock(on, at('2026-10-30T14:30:00Z'))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(status.at(-1)).toBeUndefined()
  expect(await $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor' })).toMatchObject({ agentId: 'a1' })
  expect(await $.tool.call(codexStart)).toMatchObject({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).toMatchObject({ result: 'ran' })
})

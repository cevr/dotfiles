import { expect, test, type TestBody } from 'claude-code/testing'

import { AFTER_MS, awake, awakeAfter, local, rest, sabbath, sunset } from '../hooks/sabbath'

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
  expect(awake(from, from + week)).toBe(week - (friday.end + AFTER_MS - friday.start))
  // Inside the Sabbath, nothing passes.
  expect(awake(friday.start + 60e3, friday.end - 60e3)).toBe(0)
  // Two hours before sunset, three hours awake end one hour past the rest's end.
  expect(awakeAfter(friday.start - 2 * 3600e3, 3 * 3600e3)).toBe(friday.end + AFTER_MS + 3600e3)
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

const mock = (on: Parameters<TestBody>[1], time: number | (() => number)) => {
  const status: (string | undefined)[] = []
  const ticks: (() => void)[] = []
  const prompts: string[] = []
  const store = new Map<string, unknown>()
  on('clock.now', () => ({ value: typeof time === 'number' ? time : time() }))
  // Each period ends when the test calls its tick.
  on('clock.every', () => new Promise(resolve => ticks.push(() => resolve({ value: undefined }))))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  // The engine takes each prompt unless `drop` says it drops them.
  const submit = { drop: false }
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return submit.drop ? { drop: 'busy' } : { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }))
  on('tool.call', () => ({ result: 'ran' }))
  return { status, ticks, prompts, submit }
}

test('the rest runs from Friday sunset to 30 minutes after Saturday sunset', () => {
  const friday = sabbath(at('2026-10-30T14:30:00Z'))
  expect(rest(friday.start - 60e3)).toMatchObject({ on: false, start: friday.start, end: friday.end + AFTER_MS })
  expect(rest(friday.end + 60e3)).toMatchObject({ on: true, end: friday.end + AFTER_MS })
  expect(local(rest(friday.end).end)).toBe('Sat 18:09')
  expect(rest(friday.end + AFTER_MS).on).toBe(false)
})

test('during the Sabbath no agent work starts, a running subagent is told to stop, and Codex turns go to the bridge to latch', async ($, on) => {
  const { status } = mock(on, at('2026-10-31T12:00:00Z'))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(status.at(-1)).toBe('Sabbath; work resumes Sat 18:09')

  expect(await $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor' })).toEqual({ deny: expect.stringContaining('resumes at Sat 18:09') })
  expect(await $.tool.call(codexStart)).toMatchObject({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).toEqual({ deny: expect.stringContaining('Stop now') })
  // The main loop still answers the owner.
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toMatchObject({ result: 'ran' })
})

test('once the rest ends, the session gets one message to resume the work it held', async ($, on) => {
  let time = at('2026-10-31T12:00:00Z')
  const { ticks, prompts } = mock(on, () => time)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  await $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor', description: 'implementor sheet r2' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'a1' })
  for (const t of ticks.splice(0)) t()
  await settle()
  expect(prompts).toEqual([])

  // The session starts again after the rest, as after a restart, and ticks once more.
  time = at('2026-10-31T22:10:00Z')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  for (const t of ticks.splice(0)) t()
  await settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('The Sabbath rest ended at Sat 18:09')
  expect(prompts[0]).toContain('implementor sheet r2')
  expect(prompts[0]!.match(/subagent a1/g)).toHaveLength(1)
})

test('refusals at once are all kept, and a dropped resume message is sent again on the next tick', async ($, on) => {
  let time = at('2026-10-31T12:00:00Z')
  const { ticks, prompts, submit } = mock(on, () => time)
  submit.drop = true
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  await Promise.all(['a', 'b', 'c'].map(d => $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor', description: `implementor ${d} r1` })))
  time = at('2026-10-31T22:10:00Z')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(prompts).toHaveLength(1)
  for (const d of ['a', 'b', 'c']) expect(prompts[0]).toContain(`implementor ${d} r1`)
  submit.drop = false
  for (const t of ticks.splice(0)) t()
  await settle()
  for (const t of ticks.splice(0)) t()
  await settle()
  expect(prompts).toHaveLength(2)
})

test('outside the Sabbath everything runs, and the status line is clear', async ($, on) => {
  const { status } = mock(on, at('2026-10-30T14:30:00Z'))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(status.at(-1)).toBeUndefined()
  expect(await $.agent.spawn({ ...SPAWN, subagentType: 'orchestrate-implementor' })).toMatchObject({ agentId: 'a1' })
  expect(await $.tool.call(codexStart)).toMatchObject({ result: 'ran' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).toMatchObject({ result: 'ran' })
})

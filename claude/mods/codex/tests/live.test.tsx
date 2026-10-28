import { expect, test, type TestBody } from 'claude-code/testing'

import type { Budget, Thread } from '../types'

// The bridge, as the mod reaches it: `codex-bridge ensure`, then HTTP on its socket.
const running: Thread = {
  id: 't1',
  description: 'reviewer sheet r1',
  model: 'gpt-6.1-sol',
  effort: 'max',
  status: 'running',
  turns: 1,
  compactions: 0,
  usage: { tokens: 40000, context: 41000, window: 100000 },
  live: {
    since: 0,
    running: { w1: '$ bun test' },
    steps: [
      { at: 0, text: 'edit queue.ts' },
      { at: 0, text: '$ bun run lint', failed: true },
    ],
    commands: 4,
    edits: 1,
    tools: 0,
    plan: [
      { step: 'read', status: 'completed' },
      { step: 'test', status: 'inProgress' },
    ],
  },
  updatedAt: 0,
}

const held: Budget = {
  start: { ok: false, reason: 'the 7-day window is 58% used; an even burn to 99% by 2026-11-01 12:00Z allows 42% now, and 58% at 2026-10-28 14:24Z', until: 0 },
  send: { ok: true },
  summary: 'Codex budget: 7-day window: 58% used; even line 42% now; 99% by 2026-11-01 12:00Z. New threads held; next turns go on.',
}

function bridge(on: Parameters<TestBody>[1], threads: () => Thread[], budget: Budget = { start: { ok: true }, send: { ok: true }, summary: 'Codex usage unknown; no budget applied.' }) {
  on('ui.status', () => ({ value: undefined }))
  // The engine's own footer, beneath the mod.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine footer</Text>
  })
  // The kit types this answer's value as undefined; the runner takes the ProcessRunResult that $.process.run resolves.
  // @ts-expect-error
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"socket":"/tmp/bridge.sock"}', stderr: '' } }))
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const body = path === '/start' ? (threads().find(t => t.status === 'queued') ?? running) : path === '/send' ? threads()[0] : path === '/threads' ? threads() : path === '/events' ? [] : path === '/budget' ? budget : null
    return { value: { ok: true, status: 200, text: JSON.stringify(body), headers: {} } }
  })
  on('command.register', () => ({ value: { command: 'codex' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__codex__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 60e3 }))
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/' }))
}

const FOOTER = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } } as const
const footer = async ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ plugin: 'codex', surface, ...FOOTER })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a start call's row and a footer line show the thread's live work (${surface})`, async ($, on) => {
    bridge(on, () => [running, { ...running, id: 't2', description: 'implementor queue r2' }])
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const call = await $.tool.call({ tool: 'mcp__codex__start', description: 'reviewer sheet r1', prompt: 'review', tool_use_id: 'tu1' })
    expect(JSON.stringify(call)).toContain('Started Codex thread t1')

    const row = await $.ui.mount({
      plugin: 'codex',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'tu1', tool: 'mcp__codex__start', output: call.result, isErrored: false },
    })
    expect((await row.find({ type: 'Text', text: /running/ }))?.text).toContain('reviewer sheet r1')
    expect((await row.find({ type: 'Text', text: /4 commands/ }))?.text).toContain('context 41%')
    expect((await row.find({ type: 'Text', text: /plan/ }))?.text).toContain('plan 1/2: test')
    expect(await row.find({ type: 'Text', text: /▸ \$ bun test/ })).toBeDefined()
    expect(await row.find({ type: 'Text', text: /✗ \$ bun run lint/ })).toBeDefined()
    await row.unmount()

    expect(await footer($, surface)).toEqual([
      'engine footer',
      '◆ codex reviewer sheet r1 · running 1m 0s · 4 commands · 1 edit · context 41% · ▸ $ bun test',
      '◆ codex implementor queue r2 · running 1m 0s · 4 commands · 1 edit · context 41% · ▸ $ bun test',
    ])
  })
}

test('a thread from a bridge with no live record counts from its last update', async ($, on) => {
  bridge(on, () => [{ ...running, live: undefined, updatedAt: 15e3 }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__codex__start', description: 'reviewer sheet r1', prompt: 'review', tool_use_id: 'tu1' })
  expect((await footer($, 'terminal'))[1]).toBe('◆ codex reviewer sheet r1 · running 45s · context 41%')
})

test('the footer is the engine\'s alone when no thread runs', async ($, on) => {
  let threads: Thread[] = [running]
  bridge(on, () => threads)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__codex__start', description: 'reviewer sheet r1', prompt: 'review', tool_use_id: 'tu1' })
  expect(await footer($, 'terminal')).toHaveLength(2)
  threads = [{ ...running, status: 'idle', live: { ...running.live!, running: {} } }]
  await $.tool.call({ tool: 'mcp__codex__send', thread: 't1', prompt: 'again', tool_use_id: 'tu3' })
  expect(await footer($, 'terminal')).toEqual(['engine footer'])
})

test('the threads tool reports the Codex budget and why it holds new threads', async ($, on) => {
  bridge(on, () => [running], held)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__codex__threads', tool_use_id: 'tu1' })
  expect(answer).toMatchObject({ result: expect.stringContaining(held.summary) })
  expect(answer).toMatchObject({ result: expect.stringContaining(`New threads: ${held.start.reason}.`) })
})

test('a latched start says why it waits, and its footer line shows it latched', async ($, on) => {
  const queued: Thread = { ...running, status: 'queued', held: 'the bridge is updating', live: undefined, updatedAt: 50e3 }
  bridge(on, () => [queued])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__codex__start', description: 'reviewer sheet r1', prompt: 'review', tool_use_id: 'tu1' })
  expect(answer).toMatchObject({ result: expect.stringContaining('Queued Codex thread t1') })
  expect(answer).toMatchObject({ result: expect.stringContaining('The turn is latched (the bridge is updating); it starts by itself when there is room.') })
  expect((await footer($, 'terminal'))[1]).toBe('◆ codex reviewer sheet r1 · latched 10s: the bridge is updating · context 41%')
})

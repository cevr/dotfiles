import { expect, test, type TestBody } from 'claude-code/testing'

// The bridge, as the mod reaches it: `codex-bridge ensure`, then HTTP on its socket.
const running = {
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

function bridge(on: Parameters<TestBody>[1], threads: () => unknown[]) {
  // The kit types this answer's value as undefined; the runner takes the ProcessRunResult that $.process.run resolves.
  // @ts-expect-error
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"socket":"/tmp/bridge.sock"}', stderr: '' } }))
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const body = path === '/start' ? running : path === '/threads' ? threads() : path === '/events' ? [] : null
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a start call's row and the band show the thread's live work (${surface})`, async ($, on) => {
    bridge(on, () => [running])
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

    const band = await $.ui.mount({
      plugin: 'codex',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    })
    expect((await band.find({ type: 'Text', text: /codex reviewer sheet r1/ }))?.text).toContain('$ bun test')
    await band.unmount()
  })
}

test('the band stays empty when no thread runs', async ($, on) => {
  bridge(on, () => [{ ...running, status: 'idle', live: { ...running.live, running: {} } }])
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'codex',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await band.unmount()
})

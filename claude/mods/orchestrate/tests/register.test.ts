import { describe, expect, mock, test } from 'claude-code/testing'

const herdrAgent = (name: string | null) => ({
  exitCode: 0,
  stdout: JSON.stringify({ result: { type: 'agent_info', agent: { name, agent_status: 'working' } } }),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

describe('guard', () => {
  test('an implementor pane cannot poll or hand off to a missing file', async ($, on) => {
    mock.env(on, { HERDR_PANE_ID: 'w1:p2', HOME: '/home/u' })
    on('process.run', () => ({ value: herdrAgent('hymn-src-impl') }))
    mock.clock(on)
    on('fs.exists', (_, e) => ({ value: e.path === '/r/src/round-1-request.md' }))
    let ran = 0
    on('tool.call', () => {
      ran += 1
      return { result: 'ok' }
    })

    const polled = await $.tool.call({ tool: 'Bash', command: 'herdr agent wait hymn-src-rev' })
    expect(polled).toEqual({ deny: 'orchestrate: no polling. End your turn; the next herdr message wakes you.' })
    const missing = await $.tool.call({
      tool: 'Bash',
      command: 'herdr agent prompt hymn-src-rev "[hymn-src] Round 1 ready: /r/src/nope.md"',
    })
    expect(missing).toEqual({ deny: 'orchestrate: /r/src/nope.md does not exist; write it, then hand off.' })
    await $.tool.call({
      tool: 'Bash',
      command: 'herdr agent prompt hymn-src-rev "[hymn-src] Round 1 ready: /r/src/round-1-request.md"',
    })
    expect(ran).toBe(1)
  })

  test('outside a track pane the guard stays out of the way', async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    let ran = 0
    on('tool.call', () => {
      ran += 1
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Bash', command: 'sleep 30' })
    expect(ran).toBe(1)
  })
})

describe('watchdog', () => {
  test('a track quiet past the threshold alerts the orchestrator once', async ($, on) => {
    mock.env(on, { HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
    const clock = mock.clock(on)
    const run = '/home/u/.cache/orchestrate/repo/hymn'
    on('process.run', (_, e) => {
      const listed = e.argv[2] === 'list'
      const result = listed
        ? { agents: [{ name: 'hymn-src-impl', agent_status: 'idle' }, { name: 'hymn-src-rev', agent_status: 'idle' }] }
        : { agent: { name: 'hymn-orch' } }
      return { value: { exitCode: 0, stdout: JSON.stringify({ result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.exists', () => ({ value: true }))
    on('fs.list', (_, e) => ({
      value:
        e.path === `${run}/src`
          ? [{ name: 'round-1-request.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }]
          : [{ name: 'repo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
    }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => e)
    on('ui.status', () => ({ value: undefined }))
    const submitted: string[] = []
    on('prompt.submit', (_, e) => {
      submitted.push(e.text)
      return e
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(9 * 60_000)
    expect(submitted).toEqual([])
    await clock.advance(3 * 60_000)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain("[watchdog] hymn-src: every agent idle")
    expect(submitted[0]).toContain(`unit folder ${run}/src`)
    await clock.advance(10 * 60_000)
    expect(submitted).toHaveLength(1)
  })
})

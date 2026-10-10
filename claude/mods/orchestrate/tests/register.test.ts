import { describe, expect, mock, test } from 'claude-code/testing'

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

describe('guard', () => {
  test('a baton seat cannot poll or message the run by hand', async ($, on) => {
    mock.env(on, { HERDR_PANE_ID: 'w1:p2' })
    mock.clock(on)
    on('process.run', () => ran('[{"run":"hymn","role":"impl","track":"hymn-src"}]'))
    let passed = 0
    on('tool.call', () => {
      passed += 1
      return { result: 'ok' }
    })

    const polled = await $.tool.call({ tool: 'Bash', command: 'herdr agent wait hymn-src-rev' })
    expect(polled).toEqual({ deny: 'orchestrate: no polling. End your turn; the next baton message wakes you.' })
    const byHand = await $.tool.call({ tool: 'Bash', command: 'herdr agent prompt hymn-src-rev "ready"' })
    expect('deny' in byHand && byHand.deny).toContain('baton pass')
    await $.tool.call({ tool: 'Bash', command: 'baton pass /r/src/round-1-request.md' })
    expect(passed).toBe(1)
  })

  test('outside a baton run the guard stays out of the way', async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    on('process.run', () => ran('[]'))
    let passed = 0
    on('tool.call', () => {
      passed += 1
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Bash', command: 'sleep 30' })
    expect(passed).toBe(1)
  })
})

describe('watchdog', () => {
  test("the orchestrator's session ticks baton every minute and shows the run", async ($, on) => {
    mock.env(on, { HERDR_PANE_ID: 'w1:p1' })
    const clock = mock.clock(on)
    const calls: string[] = []
    on('process.run', (_, e) => {
      const verb = e.argv.slice(1).join(' ')
      calls.push(verb)
      if (verb === 'whoami --json') return ran('[{"run":"hymn","role":"orch","track":""}]')
      if (verb === 'status --json')
        return ran(
          JSON.stringify([
            {
              run: 'hymn',
              tracks: [{ track: 'hymn-src', unit: 'src', step: 'review', holder: 'rev', round: 1, failures: 0, since: 0, agents: [] }],
              undelivered: [],
            },
          ]),
        )
      return ran('')
    })
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => e)
    const lines: (string | undefined)[] = []
    on('ui.status', (_, e) => {
      lines.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(60_000)
    expect(calls).toEqual(['whoami --json', 'tick', 'status --json'])
    expect(lines.at(-1)).toBe('hymn: 1 track')
  })
})

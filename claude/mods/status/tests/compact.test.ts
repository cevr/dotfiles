import { expect, test } from 'claude-code/testing'

import { KEEP, parseAgent, parseWindows } from '../hooks/compact'

const WORKER_FILE = `---
name: orchestrate-worker
description: Lean subagent for an orchestrate role.
tools: Bash, Read, Edit
---
You are a subagent.
`
const TUNED = JSON.stringify({ at: 0, ceiling: 200e3, windows: { 'orchestrate-worker': 140e3, root: 150e3, Explore: 50e3 } })

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
// Lets the hooks' unawaited work run to its end: the mocks answer at once.
const settle = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve()
}
const failed = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

test('reads an agent file and keeps only windows the engine takes', () => {
  expect(parseAgent(WORKER_FILE)).toEqual({
    description: 'Lean subagent for an orchestrate role.',
    tools: ['Bash', 'Read', 'Edit'],
    prompt: 'You are a subagent.',
  })
  expect(parseWindows(TUNED)).toEqual({ 'orchestrate-worker': 140e3, root: 150e3 })
})

test('workers run as the copy with the tuned window, and every compaction keeps the state files', async ($, on) => {
  const registered: Record<string, unknown>[] = []
  const spawned: string[] = []
  const instructions: (string | undefined)[] = []
  let compactions = 0
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    if (script.includes('cat') && script.includes('compact.json')) return ok(TUNED)
    if (script.includes('orchestrate-worker.md')) return ok(WORKER_FILE)
    return failed
  })
  on('agent.register', (_, e) => {
    registered.push(e)
    return { value: { agent: `status:${e.name}` } }
  })
  // The engine offers every type; a plugin's hook may refuse one.
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', (_, e) => {
    spawned.push(e.subagentType)
    return { model: 'opus' }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 160e3, window: 1e6 }, rateLimits: [] } }))
  on('session.compact', (_, e) => {
    instructions.push(e.instructions)
    compactions++
    return { skip: 'test' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The tuning runs unawaited from session start.
  await settle()
  expect(logs).toEqual([])
  // The mocked clock repeats the hourly check at once; each registration replaces the last.
  expect(registered.at(-1)).toMatchObject({ name: 'orchestrate-worker', tools: ['Bash', 'Read', 'Edit'], autoCompactWindow: 140e3 })

  const spawn = { tool_use_id: 't1', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'opus', background: false, fork: false }
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-worker' })
  await $.agent.spawn({ ...spawn, subagentType: 'Explore' })
  expect(spawned).toEqual(['status:orchestrate-worker', 'Explore'])
  // Dispatch checks the offer of the name the spawn carries: the copy must be offered.
  const copy = { agent: 'status:orchestrate-worker', description: 'd', source: 'plugin', provider: { plugin: 'status', tier: 'user' as const } }
  expect(await $.agent.offer(copy)).toEqual({ isOffered: true })

  // 160k of context passes root's 150k window: the session compacts once the turn is over, KEEP in its instructions.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'u1', reason: 'answer' })
  await settle()
  expect(logs).toEqual([])
  expect(compactions).toBe(1)
  expect(instructions).toEqual([KEEP])

  // Another's compaction, /compact here, gets KEEP after its own instructions.
  await $.session.compact({
    trigger: 'manual',
    instructions: 'the plan',
    messages: [{ role: 'user', text: 'go', toolUses: [] }],
  })
  expect(instructions.at(-1)).toBe(`the plan\n\n${KEEP}`)
})

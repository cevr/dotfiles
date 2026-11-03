import { expect, test } from 'claude-code/testing'

import { KEEP, parseAgent, parseWindows } from '../hooks/compact'

const WORKER_FILE = `---
name: worker
description: Lean subagent for an orchestrate role.
tools: Bash, Read, Edit
---
You are a subagent.
`
const TUNED = JSON.stringify({ at: 0, ceiling: 200e3, windows: { worker: 140e3, verifier: 160e3, root: 150e3, Explore: 50e3 } })

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
  expect(parseWindows(TUNED)).toEqual({ worker: 140e3, verifier: 160e3, root: 150e3 })
})

test("an older cache's window counts for the kind's current name, unless that has its own", () => {
  expect(parseWindows(JSON.stringify({ windows: { 'orchestrate-worker': 180e3 } }))).toEqual({ worker: 180e3 })
  expect(parseWindows(JSON.stringify({ windows: { 'orchestrate-worker': 180e3, worker: 140e3 } }))).toEqual({ worker: 140e3 })
  expect(parseWindows(JSON.stringify({ windows: { 'orchestrate-reviewer': 300e3 } }))).toEqual({ verifier: 300e3 })
  expect(parseWindows(JSON.stringify({ windows: { 'orchestrate-implementor': 400e3, 'orchestrate-planner': 200e3 } }))).toEqual({ implementor: 400e3, planner: 200e3 })
  expect(parseWindows(JSON.stringify({ windows: { 'orchestrate-verifier': 300e3, verifier: 160e3 } }))).toEqual({ verifier: 160e3 })
})

test('workers and roles run as copies with their tuned windows, and every compaction keeps the state files', async ($, on) => {
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
    const kind = script.match(/(planner|implementor|verifier|worker)(?=\.md)/)?.[0]
    if (kind) return ok(WORKER_FILE.replace('name: worker', `name: ${kind}`))
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
  const last = (name: string) => registered.findLast(r => r.name === name)
  expect(last('worker')).toMatchObject({ tools: ['Bash', 'Read', 'Edit'], autoCompactWindow: 140e3 })
  // A tuned role keeps its own window; an untuned one takes the worker's.
  expect(last('verifier')).toMatchObject({ autoCompactWindow: 160e3 })
  expect(last('orchestrate-verifier')).toBeUndefined()
  expect(last('implementor')).toMatchObject({ autoCompactWindow: 140e3 })

  const spawn = { tool_use_id: 't1', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'opus', background: false, fork: false }
  await $.agent.spawn({ ...spawn, subagentType: 'worker' })
  // A session mid-run still asks for the former name, before or after the guard hook renames it.
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-worker' })
  await $.agent.spawn({ ...spawn, subagentType: 'verifier' })
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-verifier' })
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-reviewer' })
  await $.agent.spawn({ ...spawn, subagentType: 'status:orchestrate-reviewer' })
  await $.agent.spawn({ ...spawn, subagentType: 'status:orchestrate-verifier' })
  await $.agent.spawn({ ...spawn, subagentType: 'status:verifier' })
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-implementor' })
  await $.agent.spawn({ ...spawn, subagentType: 'status:orchestrate-implementor' })
  await $.agent.spawn({ ...spawn, subagentType: 'orchestrate-planner' })
  await $.agent.spawn({ ...spawn, subagentType: 'Explore' })
  expect(spawned).toEqual([
    'status:worker',
    'status:worker',
    ...Array(6).fill('status:verifier'),
    'status:implementor',
    'status:implementor',
    'status:planner',
    'Explore',
  ])
  // Dispatch checks the offer of the name the spawn carries: the copy must be offered.
  const copy = { agent: 'status:worker', description: 'd', source: 'plugin', provider: { plugin: 'status', tier: 'user' as const } }
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

test('a reload registers the copies before the tune ends, and warns of agents that ran past their window', async ($, on) => {
  const registered: string[] = []
  const toasts: string[] = []
  const overran = JSON.stringify({
    ...JSON.parse(TUNED),
    kinds: [
      { kind: 'implementor', window: 120e3, overrun: 22 },
      { kind: 'verifier', window: 160e3, overrun: 0 },
      { kind: 'Explore', window: 140e3, overrun: 3 },
    ],
  })
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    // The tune never ends here.
    if (script.includes('--tune')) return new Promise(() => {})
    if (script.includes('cat') && script.includes('compact.json')) return ok(overran)
    const kind = script.match(/(planner|implementor|verifier|worker)(?=\.md)/)?.[0]
    if (kind) return ok(WORKER_FILE.replace('name: worker', `name: ${kind}`))
    return failed
  })
  on('agent.register', (_, e) => {
    registered.push(e.name)
    return { value: { agent: `status:${e.name}` } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  expect(registered).toContain('implementor')
  expect(toasts).toEqual([expect.stringContaining('22 implementor past 120k')])
  expect(toasts[0]).not.toContain('Explore')
})

test("an older cache with a wide worker window registers the copies at each kind's cap, and warns of an untuned role that ran past it", async ($, on) => {
  const registered: Record<string, unknown>[] = []
  const toasts: string[] = []
  const wide = JSON.stringify({
    at: 0,
    ceiling: 1e6,
    windows: { 'orchestrate-worker': 400e3 },
    kinds: [],
    untuned: [{ kind: 'verifier', window: 200e3, overrun: 1 }],
  })
  on('command.register', () => ({ value: { command: 'pool' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => {
    const script = e.argv.join(' ')
    if (script.includes('--tune')) return new Promise(() => {})
    if (script.includes('cat') && script.includes('compact.json')) return ok(wide)
    const kind = script.match(/(planner|implementor|verifier|worker)(?=\.md)/)?.[0]
    if (kind) return ok(WORKER_FILE.replace('name: worker', `name: ${kind}`))
    return failed
  })
  on('agent.register', (_, e) => {
    registered.push(e)
    return { value: { agent: `status:${e.name}` } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  // Two loads (before the tune and the mocked hourly one); each registers all four kinds.
  expect(new Set(registered.map(r => r.name)).size).toBe(4)
  for (const r of registered) expect(r).toMatchObject({ autoCompactWindow: ['planner', 'implementor', 'verifier'].includes(String(r.name)) ? 400e3 : 200e3 })
  expect(toasts).toEqual([expect.stringContaining('1 verifier past 200k')])
})

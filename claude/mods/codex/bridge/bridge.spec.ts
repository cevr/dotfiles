import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
const log = join(dir, 'requests.jsonl')
const agents = join(dir, 'agents')
process.env.CODEX_BRIDGE_DIR = dir
process.env.CODEX_BRIDGE_AGENTS = agents
process.env.CODEX_BRIDGE_CODEX = `${process.execPath} ${join(import.meta.dir, 'fake-app-server.ts')}`
process.env.FAKE_LOG = log
const { Bridge, handler, newest, roleAgent } = await import('./bridge.ts')

const requests = () =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { method: string; params: any })
const state = join(dir, 'state.json')
const bridges: InstanceType<typeof Bridge>[] = []
const open = () => {
  const bridge = new Bridge(state)
  bridges.push(bridge)
  const http = handler(bridge)
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await http(new Request(`http://bridge${path}`, { method, body: body && JSON.stringify(body) }))
    return { status: response.status, body: (await response.json()) as any }
  }
  return { bridge, call }
}
// The fake finishes a turn in the same burst of output; the bridge reads it a tick later.
const settle = () => Bun.sleep(50)

beforeAll(() => {
  require('node:fs').mkdirSync(agents)
  writeFileSync(
    join(agents, 'orchestrate-implementor.toml'),
    `name = "orchestrate-implementor"\nmodel_reasoning_effort = "max"\ndeveloper_instructions = '''\nYou are the implementor of one orchestrate unit.\n'''\n`,
  )
})

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.server.stop()
  rmSync(state, { force: true })
  rmSync(log, { force: true })
})

describe('newest', () => {
  const slugs = ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-reserve']
  test('picks the highest version of a family and passes a full slug through', () => {
    expect(newest('luna', slugs)).toBe('gpt-6-luna')
    expect(newest('sol', slugs)).toBe('gpt-6.1-sol')
    expect(newest('gpt-5.6-luna', slugs)).toBe('gpt-5.6-luna')
    expect(() => newest('astra', slugs)).toThrow()
  })
})

test('every committed Codex role agent parses with its instructions and effort', () => {
  const committed = join(import.meta.dir, '../../../../codex/agents')
  for (const role of ['planner', 'implementor', 'reviewer', 'verifier'] as const) {
    const agent = roleAgent(role, committed)
    expect(agent.instructions).toStartWith(`You are the ${role} of one orchestrate unit.`)
    expect(agent.effort).toBeString()
  }
})

describe('a thread', () => {
  test('starts as a role agent on the newest family model, and its finished turn waits for its owner until acked', async () => {
    const { call } = open()
    const started = await call('POST', '/start', {
      owner: 's1',
      description: 'implementor sheet r1',
      prompt: 'build it',
      cwd: dir,
      role: 'implementor',
      model: 'luna',
    })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ id: 't1', model: 'gpt-6-luna', effort: 'max', status: 'running' })
    const start = requests().find(r => r.method === 'thread/start')!
    expect(start.params.developerInstructions).toStartWith('You are the implementor of one orchestrate unit.')
    expect(start.params.config).toEqual({ model_reasoning_effort: 'max' })

    await settle()
    const events = (await call('GET', '/events?owner=s1')).body
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      threadId: 't1',
      description: 'implementor sheet r1',
      status: 'completed',
      final: 'done: build it',
      durationMs: 42,
      usage: { tokens: 1000, context: 500, window: 1000 },
    })
    expect((await call('GET', '/events?owner=s2')).body).toEqual([])
    expect((await call('GET', '/limits')).body).toMatchObject({ limitId: 'codex' })

    await call('POST', '/ack', { owner: 's1', seqs: [events[0].seq] })
    expect((await call('GET', '/events?owner=s1')).body).toEqual([])
  })

  test('takes the next round on the same thread, resumed first when a new daemon holds it', async () => {
    const first = open()
    await first.call('POST', '/start', { owner: 's1', description: 'implementor sheet r1', prompt: 'build it', cwd: dir })
    await settle()
    first.bridge.server.stop()

    const second = open()
    const sent = await second.call('POST', '/send', { threadId: 't1', prompt: 'fix round 2' })
    expect(sent.body).toMatchObject({ id: 't1', status: 'running', turns: 2 })
    await settle()
    const methods = requests().map(r => r.method)
    expect(methods.slice(methods.lastIndexOf('initialize'))).toEqual(['initialize', 'account/rateLimits/read', 'thread/resume', 'turn/start'])
    const events = (await second.call('GET', '/events?owner=s1')).body
    expect(events.map((e: any) => e.final)).toEqual(['done: build it', 'done: fix round 2'])
  })

  test("keeps a live record of the turn's work for the mod's view", async () => {
    const { call } = open()
    const started = await call('POST', '/start', { owner: 'live', description: 'work', prompt: 'work hang', cwd: dir })
    await settle()
    const [thread] = (await call('GET', '/threads?owner=live')).body
    expect(thread.live).toMatchObject({
      running: { w1: 'search effect deferred' },
      steps: [{ text: '$ bun test', failed: true }, { text: 'edit a.ts' }],
      commands: 1,
      edits: 1,
      plan: [{ step: 'fix', status: 'completed' }, { step: 'test', status: 'inProgress' }],
    })
    await call('POST', '/interrupt', { threadId: started.body.id })
    await settle()
    const [ended] = (await call('GET', '/threads?owner=live')).body
    expect(ended.live.running).toEqual({})
    expect(ended.live.commands).toBe(1)
  })

  test('refuses a second turn while one runs, and an interrupt finishes it as interrupted', async () => {
    const { call } = open()
    await call('POST', '/start', { owner: 's1', description: 'implementor sheet r1', prompt: 'hang on', cwd: dir })
    const refused = await call('POST', '/send', { threadId: 't1', prompt: 'more' })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('running')

    await call('POST', '/interrupt', { threadId: 't1' })
    await settle()
    expect((await call('GET', '/events?owner=s1')).body).toMatchObject([{ status: 'interrupted' }])
  })

  test('a turn left running by a stopped daemon reaches its owner as failed', async () => {
    const first = open()
    await first.call('POST', '/start', { owner: 's1', description: 'implementor sheet r1', prompt: 'hang on', cwd: dir })
    first.bridge.server.stop()
    await settle()

    const second = open()
    const events = (await second.call('GET', '/events?owner=s1')).body
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'failed', error: 'codex app-server exited' })
    expect((await second.call('GET', '/threads?owner=s1')).body).toMatchObject([{ id: 't1', status: 'failed' }])
  })

  test('events and threads untouched for two weeks are dropped when a daemon starts', async () => {
    const old = Date.now() - 15 * 24 * 60 * 60e3
    const thread = { id: 'old', owner: 's9', status: 'idle', updatedAt: old }
    writeFileSync(
      state,
      JSON.stringify({ seq: 2, threads: { old: thread, new: { ...thread, id: 'new', updatedAt: Date.now() } }, events: [{ seq: 1, at: old, owner: 's9' }, { seq: 2, at: Date.now(), owner: 's9' }] }),
    )
    const { call } = open()
    expect((await call('GET', '/events?owner=s9')).body.map((e: any) => e.seq)).toEqual([2])
    expect((await call('GET', '/threads?owner=s9')).body.map((t: any) => t.id)).toEqual(['new'])
  })
})

describe('the budget', () => {
  const DAY = 24 * 60 * 60e3
  // A week 2 days in, 58% used: past the even line (42% with a day's lead).
  const ahead = () => JSON.stringify({ limitId: 'codex', primary: { usedPercent: 58, windowDurationMins: 7 * 1440, resetsAt: Math.round((Date.now() + 5 * DAY) / 1e3) } })
  afterEach(() => delete process.env.FAKE_LIMITS)

  test('holds a new thread ahead of an even burn, and lets a started thread take its next turn', async () => {
    const first = open()
    await first.call('POST', '/start', { owner: 's1', description: 'implementor sheet r1', prompt: 'build it', cwd: dir })
    await settle()
    first.bridge.server.stop()

    process.env.FAKE_LIMITS = ahead()
    const { call } = open()
    const refused = await call('POST', '/start', { owner: 's1', description: 'reviewer sheet r1', prompt: 'review it', cwd: dir })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toStartWith('The Codex budget holds a new Codex thread: the 7-day window is 58% used')
    expect(requests().filter(r => r.method === 'thread/start')).toHaveLength(1)

    const sent = await call('POST', '/send', { threadId: 't1', prompt: 'fix round 2' })
    expect(sent.body).toMatchObject({ id: 't1', status: 'running', turns: 2 })
    expect((await call('GET', '/budget')).body).toMatchObject({ start: { ok: false }, send: { ok: true } })
  })
})

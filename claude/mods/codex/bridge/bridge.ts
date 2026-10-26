#!/usr/bin/env bun
// codex-bridge: one daemon per host that holds `codex app-server` open over stdio
// and serves its threads over HTTP on a Unix socket, for the codex mod (and a shell).
// A thread outlives the Claude session's module: a reload or a restart of the
// session reads its finished turns again by owner, so no completion is lost.
//
//   codex-bridge ensure          start the daemon unless it answers; prints {"socket"}
//   codex-bridge serve           run the daemon in the foreground
//   codex-bridge status          the daemon's threads, as JSON
//
// HTTP (all JSON): GET /health, POST /start, POST /send, POST /interrupt,
// GET /threads?owner=, GET /events?owner=, POST /ack, GET /limits.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Role = 'planner' | 'implementor' | 'reviewer' | 'verifier'
export type Usage = { tokens: number; input: number; cached: number; output: number; context: number; window: number }
/**
 * What a thread's current or last turn does, for the mod's live view: the items
 * running now by id, the last finished steps, the counts and Codex's plan.
 */
export type Live = {
  since: number
  running: Record<string, string>
  steps: { at: number; text: string; failed?: boolean }[]
  commands: number
  edits: number
  tools: number
  plan?: { step: string; status: string }[]
}
export type Thread = {
  id: string
  owner: string
  description: string
  role?: Role
  cwd: string
  model: string
  effort?: string
  status: 'running' | 'idle' | 'failed' | 'interrupted'
  turnId?: string
  turns: number
  compactions: number
  final?: string
  usage?: Usage
  live?: Live
  startedAt: number
  updatedAt: number
}
export type Event = {
  seq: number
  at: number
  owner: string
  threadId: string
  description: string
  model: string
  effort?: string
  status: 'completed' | 'interrupted' | 'failed'
  error?: string
  final: string
  durationMs: number
  usage?: Usage
  compactions: number
}
type State = { seq: number; threads: Record<string, Thread>; events: Event[] }

const STATE_DIR = process.env.CODEX_BRIDGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'codex-bridge')
export const SOCKET = join(STATE_DIR, 'bridge.sock')
const STATE = join(STATE_DIR, 'state.json')
const LOCK = join(STATE_DIR, 'serve.lock')
const LOG = join(STATE_DIR, 'bridge.log')
const AGENTS = process.env.CODEX_BRIDGE_AGENTS ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'agents')
// The command that speaks the app-server protocol on stdio; a test points it at a fake.
const CODEX = (process.env.CODEX_BRIDGE_CODEX ?? 'codex app-server').split(' ')
const FAMILIES = ['luna', 'sol', 'terra', 'astra']
const KEEP_MS = 14 * 24 * 60 * 60e3
const STEPS = 12

// `/bin/zsh -lc 'bun test'` is `bun test`.
const unwrap = (command: string) => /^\S*\b(?:zsh|bash|sh) -l?c '(.*)'$/s.exec(command)?.[1] ?? command
const short = (text: string, n = 120) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** One line for a thread item as the live view shows it; undefined for items that are not work. */
export function describe(item: any): string | undefined {
  switch (item?.type) {
    case 'commandExecution':
      return `$ ${short(unwrap(String(item.command ?? '')))}`
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c: { path: string }) => c.path.split('/').pop())
      return `edit ${short(paths.join(', ') || 'files')}`
    }
    case 'mcpToolCall':
      return `tool ${item.server}.${item.tool}`
    case 'dynamicToolCall':
      return `tool ${item.tool}`
    case 'collabAgentToolCall':
      return `agent ${item.tool}`
    case 'webSearch':
      return `search ${short(String(item.query ?? ''))}`
    case 'imageView':
      return `view ${String(item.path ?? '').split('/').pop()}`
    case 'reasoning':
      return item.summary?.[0] ? `think: ${short(item.summary[0])}` : 'think'
    case 'agentMessage':
      return 'write the answer'
    case 'plan':
      return 'plan'
    case 'contextCompaction':
      return 'compact the context'
    default:
      return undefined
  }
}

const failedItem = (item: any) =>
  item?.status === 'failed' || item?.status === 'declined' || (typeof item?.exitCode === 'number' && item.exitCode !== 0)

/** The newest slug of a family (`luna` → `gpt-6-luna`); a full slug passes through. */
export function newest(model: string, slugs: readonly string[]): string {
  if (!FAMILIES.includes(model)) return model
  const version = (slug: string) => new RegExp(`^gpt-([\\d.]+)-${model}$`).exec(slug)?.[1]?.split('.').map(Number)
  const ranked = slugs
    .flatMap(slug => (version(slug) ? [{ slug, v: version(slug)! }] : []))
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) if ((a.v[i] ?? 0) !== (b.v[i] ?? 0)) return (b.v[i] ?? 0) - (a.v[i] ?? 0)
      return 0
    })
  if (!ranked[0]) throw new Error(`no ${model} model in ${slugs.join(', ')}`)
  return ranked[0].slug
}

/** A role agent's instructions and effort, from the file agents.ts writes for Codex. */
export function roleAgent(role: Role, dir = AGENTS): { instructions: string; effort?: string } {
  const file = Bun.TOML.parse(readFileSync(join(dir, `orchestrate-${role}.toml`), 'utf8')) as Record<string, string>
  if (!file.developer_instructions) throw new Error(`orchestrate-${role}.toml has no developer_instructions`)
  return { instructions: file.developer_instructions, effort: file.model_reasoning_effort }
}

// One `codex app-server` child: newline-delimited JSON-RPC both ways.
class AppServer {
  private child: ReturnType<typeof Bun.spawn> | undefined
  private ready: Promise<void> | undefined
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  /** Threads this child has loaded; a thread from an earlier child is resumed before its turn. */
  readonly loaded = new Set<string>()

  constructor(
    private onNotification: (method: string, params: any) => void,
    private onExit: () => void,
  ) {}

  start(): Promise<void> {
    this.ready ??= this.boot()
    return this.ready
  }

  private async boot() {
    const child = Bun.spawn(CODEX, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: process.env })
    this.child = child
    void this.read(child)
    await this.request('initialize', { clientInfo: { name: 'codex_bridge', title: 'codex-bridge', version: '0.1.0' }, capabilities: null })
    this.write({ method: 'initialized' })
  }

  private async read(child: ReturnType<typeof Bun.spawn>) {
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.trim()) this.receive(line)
      }
    }
    await child.exited
    if (this.child !== child) return
    this.child = undefined
    this.ready = undefined
    this.loaded.clear()
    for (const { reject } of this.pending.values()) reject(new Error('codex app-server exited'))
    this.pending.clear()
    this.onExit()
  }

  private receive(line: string) {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method !== undefined && message.id !== undefined) {
      // A request from the server (an approval, a user-input ask). Threads run
      // with the host's approval policy; nobody is here to answer, so refuse.
      this.write({ id: message.id, error: { code: -32601, message: 'codex-bridge answers no server requests' } })
    } else if (message.method !== undefined) {
      this.onNotification(message.method, message.params)
    } else {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else waiter?.resolve(message.result)
    }
  }

  private write(message: unknown) {
    const stdin = this.child?.stdin
    if (!stdin || typeof stdin === 'number') throw new Error('codex app-server is not running')
    stdin.write(JSON.stringify(message) + '\n')
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  async call(method: string, params: unknown): Promise<any> {
    await this.start()
    return this.request(method, params)
  }

  stop() {
    this.child?.kill()
  }
}

export class Bridge {
  private state: State
  private lastLimits: unknown
  private slugs: string[] | undefined
  readonly server: AppServer

  constructor(private file = STATE) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { seq: 0, threads: {}, events: [] }
    // A session that never came back for its events (a `-p` run) leaves them; they go after two weeks.
    const kept = Date.now() - KEEP_MS
    this.state.events = this.state.events.filter(event => event.at > kept)
    for (const [id, thread] of Object.entries(this.state.threads)) if (thread.updatedAt < kept) delete this.state.threads[id]
    // A turn that was running when the last daemon stopped has no child to finish it.
    for (const thread of Object.values(this.state.threads)) if (thread.status === 'running') this.finish(thread, 'failed', 'codex-bridge restarted')
    this.server = new AppServer(
      (method, params) => this.notify(method, params),
      () => {
        for (const thread of Object.values(this.state.threads)) if (thread.status === 'running') this.finish(thread, 'failed', 'codex app-server exited')
      },
    )
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state))
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** True while any thread runs a turn. */
  busy() {
    return Object.values(this.state.threads).some(thread => thread.status === 'running')
  }

  private thread(id: string) {
    const thread = this.state.threads[id]
    if (!thread) throw new Error(`no thread ${id}`)
    return thread
  }

  private finish(thread: Thread, status: Exclude<Thread['status'], 'running'>, error?: string, durationMs = 0) {
    thread.status = status
    thread.turnId = undefined
    thread.updatedAt = Date.now()
    this.state.events.push({
      seq: ++this.state.seq,
      at: thread.updatedAt,
      owner: thread.owner,
      threadId: thread.id,
      description: thread.description,
      model: thread.model,
      effort: thread.effort,
      status: status === 'idle' ? 'completed' : status,
      error,
      final: thread.final ?? '',
      durationMs,
      usage: thread.usage,
      compactions: thread.compactions,
    })
    this.save()
  }

  notify(method: string, params: any) {
    if (method === 'account/rateLimits/updated') this.lastLimits = params.rateLimits
    const thread = params?.threadId ? this.state.threads[params.threadId] : undefined
    if (!thread) return
    this.track(thread, method, params)
    if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text?.trim()) thread.final = params.item.text
    if (method === 'item/completed' && params.item?.type === 'contextCompaction') thread.compactions++
    if (method === 'thread/tokenUsage/updated') {
      const { total, last, modelContextWindow } = params.tokenUsage
      thread.usage = {
        tokens: total.totalTokens,
        input: total.inputTokens,
        cached: total.cachedInputTokens,
        output: total.outputTokens,
        context: last.totalTokens,
        window: modelContextWindow ?? 0,
      }
    }
    if (method === 'turn/completed' && thread.status === 'running' && (!thread.turnId || params.turn?.id === thread.turnId)) {
      const turn = params.turn
      const final = [...(turn.items ?? [])].reverse().find((item: any) => item.type === 'agentMessage' && item.text?.trim())
      if (final) thread.final = final.text
      const status = turn.status === 'completed' ? 'idle' : turn.status === 'interrupted' ? 'interrupted' : 'failed'
      this.finish(thread, status, turn.error?.message, turn.durationMs ?? 0)
    }
  }

  // The live view's record of the turn; the counts and steps stay after it ends.
  private track(thread: Thread, method: string, params: any) {
    const live = thread.live
    if (!live) return
    const id = String(params.item?.id ?? '')
    const text = describe(params.item)
    if (method === 'item/started' && text) live.running[id] = text
    if (method === 'item/completed' && text) {
      delete live.running[id]
      // The answer and a thought are no steps: they would push the work out of the list.
      if (params.item.type !== 'agentMessage' && params.item.type !== 'reasoning') {
        live.steps = [...live.steps, { at: Date.now(), text, ...(failedItem(params.item) && { failed: true }) }].slice(-STEPS)
      }
      if (params.item.type === 'commandExecution') live.commands++
      if (params.item.type === 'fileChange') live.edits++
      if (/ToolCall$/.test(params.item.type)) live.tools++
    }
    if (method === 'turn/plan/updated') live.plan = (params.plan ?? []).map((p: any) => ({ step: String(p.step), status: String(p.status) }))
    if (method === 'turn/completed') live.running = {}
  }

  private async model(model: string | undefined) {
    if (!model || !FAMILIES.includes(model)) return model
    this.slugs ??= ((await this.server.call('model/list', { includeHidden: false })).data as { model: string }[]).map(m => m.model)
    return newest(model, this.slugs)
  }

  // Running before the request: a turn can complete in the same burst as the
  // answer that names it, before this continuation runs.
  private async turn(thread: Thread, prompt: string) {
    const before = thread.status
    const live = thread.live
    thread.status = 'running'
    thread.turnId = undefined
    thread.final = undefined
    thread.live = { since: Date.now(), running: {}, steps: [], commands: 0, edits: 0, tools: 0 }
    try {
      const { turn } = await this.server.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      })
      if (thread.status === 'running') thread.turnId = turn.id
    } catch (error) {
      thread.status = before
      thread.live = live
      throw error
    }
    thread.turns++
    thread.updatedAt = Date.now()
    this.save()
    return thread
  }

  async start(input: {
    owner: string
    description: string
    prompt: string
    cwd: string
    role?: Role
    model?: string
    effort?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  }) {
    const agent = input.role ? roleAgent(input.role) : undefined
    const effort = input.effort ?? agent?.effort
    const started = await this.server.call('thread/start', {
      model: (await this.model(input.model)) ?? null,
      cwd: input.cwd,
      sandbox: input.sandbox ?? null,
      developerInstructions: agent?.instructions ?? null,
      config: effort ? { model_reasoning_effort: effort } : null,
      serviceName: 'codex_bridge',
    })
    const thread: Thread = {
      id: started.thread.id,
      owner: input.owner,
      description: input.description,
      role: input.role,
      cwd: input.cwd,
      model: started.model,
      effort: started.reasoningEffort ?? effort,
      status: 'idle',
      turns: 0,
      compactions: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.state.threads[thread.id] = thread
    this.server.loaded.add(thread.id)
    return this.turn(thread, input.prompt)
  }

  /** The next turn on a thread: the same context and prompt cache, so a fix round is a delta. */
  async send(input: { threadId: string; prompt: string }) {
    const thread = this.thread(input.threadId)
    if (thread.status === 'running') throw new Error(`thread ${thread.id} is running turn ${thread.turnId}; interrupt it first`)
    await this.server.start()
    if (!this.server.loaded.has(thread.id)) {
      await this.server.call('thread/resume', { threadId: thread.id, excludeTurns: true })
      this.server.loaded.add(thread.id)
    }
    return this.turn(thread, input.prompt)
  }

  async interrupt(input: { threadId: string }) {
    const thread = this.thread(input.threadId)
    if (thread.status !== 'running') return thread
    if (!thread.turnId) throw new Error(`thread ${thread.id} has not started its turn yet`)
    await this.server.call('turn/interrupt', { threadId: thread.id, turnId: thread.turnId })
    return thread
  }

  threads(owner?: string) {
    return Object.values(this.state.threads).filter(thread => !owner || thread.owner === owner)
  }

  events(owner: string) {
    return this.state.events.filter(event => event.owner === owner)
  }

  ack(input: { owner: string; seqs: number[] }) {
    const seqs = new Set(input.seqs)
    this.state.events = this.state.events.filter(event => event.owner !== input.owner || !seqs.has(event.seq))
    this.save()
    return { acked: input.seqs.length }
  }

  /** The account's rate-limit windows, as the last turn reported them. */
  limits() {
    return this.lastLimits ?? null
  }
}

/** The HTTP face of a bridge; errors answer 400 with `{ error }`. */
export function handler(bridge: Bridge) {
  return async (request: Request) => {
    const url = new URL(request.url)
    const body = request.method === 'POST' ? await request.json() : undefined
    const owner = url.searchParams.get('owner') ?? undefined
    try {
      const routes: Record<string, () => unknown> = {
        'GET /health': () => ({ ok: true, pid: process.pid }),
        'POST /start': () => bridge.start(body),
        'POST /send': () => bridge.send(body),
        'POST /interrupt': () => bridge.interrupt(body),
        'GET /threads': () => bridge.threads(owner),
        'GET /events': () => bridge.events(owner ?? ''),
        'POST /ack': () => bridge.ack(body),
        'GET /limits': () => bridge.limits(),
      }
      const route = routes[`${request.method} ${url.pathname}`]
      if (!route) return Response.json({ error: `no route ${request.method} ${url.pathname}` }, { status: 404 })
      return Response.json(await route())
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 })
    }
  }
}

const healthy = async () => {
  try {
    return (await fetch('http://bridge/health', { unix: SOCKET } as RequestInit)).ok
  } catch {
    return false
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function serve() {
  mkdirSync(STATE_DIR, { recursive: true })
  if (await healthy()) return
  // One daemon per host: the lock holds the pid, and a dead holder's lock is stale.
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' })
  } catch {
    const holder = Number(readFileSync(LOCK, 'utf8'))
    if (alive(holder)) return
    writeFileSync(LOCK, String(process.pid))
  }
  rmSync(SOCKET, { force: true })
  const bridge = new Bridge()
  Bun.serve({ unix: SOCKET, fetch: handler(bridge) })
  const stop = () => {
    bridge.server.stop()
    rmSync(SOCKET, { force: true })
    rmSync(LOCK, { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  // A daemon whose source changed (a pull) hands over once no turn runs, since
  // stopping would fail a running turn. The mod's next call starts the new code.
  const source = () => statSync(import.meta.path).mtimeMs
  const built = source()
  setInterval(() => {
    if (source() !== built && !bridge.busy()) stop()
  }, 30e3)
}

async function ensure() {
  if (!(await healthy())) {
    mkdirSync(STATE_DIR, { recursive: true })
    const log = openSync(LOG, 'a')
    // Its own session, so the caller's exit (a mod's one-shot run) never takes it down.
    spawn(process.execPath, [import.meta.path, 'serve'], { stdio: ['ignore', log, log], detached: true }).unref()
    for (let i = 0; i < 50 && !(await healthy()); i++) await Bun.sleep(100)
    if (!(await healthy())) throw new Error(`codex-bridge did not start; see ${LOG}`)
  }
  console.log(JSON.stringify({ socket: SOCKET }))
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'serve') await serve()
  else if (command === 'ensure') await ensure()
  else if (command === 'status') {
    const response = await fetch('http://bridge/threads', { unix: SOCKET } as RequestInit).catch(() => undefined)
    console.log(response ? JSON.stringify(await response.json(), null, 2) : 'codex-bridge is not running')
  } else {
    console.error('usage: codex-bridge ensure | serve | status')
    process.exit(2)
  }
}

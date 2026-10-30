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
// bridge.log in the state dir has one JSON line per event: a turn latched,
// held, refused, started or ended (with its cause), resumed, a drain, a
// hand-over. A line about a thread carries its orchestrate `unit` and `round`,
// when its start named them.
//
// HTTP (all JSON): GET /health, POST /start, POST /send, POST /interrupt,
// GET /threads?owner=, GET /events?owner=, POST /ack, GET /limits, GET /budget.
// Every turn, a thread's first or a next one, passes the Codex budget: the hard
// gates of ./budget.ts, then the rate admission (orchestrate's budget.ts
// --codex --admit), or the even line of ./budget.ts when the admission cannot
// measure. A turn the budget holds is latched (status `queued`, with why), as is
// one asked of a daemon draining for an update; the pump starts latched turns,
// next turns before first ones, oldest first, as the budget makes room. A held
// turn does not hold the ones behind it that fit, until it has waited past the
// patience (PATIENCE_MIN); then it goes first and holds the rest. A hold names
// when the turn should open; a new thread whose first turn would open past the
// patience is refused at once (`held`, no thread made), for its role to run on Claude.
// A turn that ended for the infrastructure (the model at capacity, the
// app-server gone, the bridge restarted) is resumed by the bridge itself: one
// standard next turn after 1, 5 and 15 minutes; its owner hears only the end
// of the last one.
//
// The rules above live in ./policy.ts (with ./budget.ts), which the daemon loads
// again when they change: an edit there takes effect at the next decision. A
// change to this file, the core, drains the daemon and hands it over.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Limits } from './budget.ts'
import * as boot from './policy.ts'
import type { Asking, Hold } from './policy.ts'

export type Role = 'planner' | 'implementor' | 'reviewer' | 'verifier'
/** Why a turn ended: its work, its caller, or the infrastructure under it (`capacity`, `app-server-exit`, `drain-interrupt`). */
export type Cause = 'completed' | 'interrupted-by-caller' | 'capacity' | 'app-server-exit' | 'drain-interrupt' | 'error'
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
  /** The orchestrate unit and round the thread works on, when its start named them. */
  unit?: string
  round?: number
  cwd: string
  model: string
  effort?: string
  status: 'running' | 'queued' | 'idle' | 'failed' | 'interrupted'
  /** The prompt of a latched turn, and why and since when it waits. */
  queued?: string
  held?: string
  queuedAt?: number
  /** When the latched turn should start, as the budget estimates it. */
  opensAt?: number
  /** A resumed turn waits until then. */
  notBefore?: number
  /** The bridge's resumes since the thread's last turn that its owner heard of. */
  resumes?: number
  /** The caller asked to stop the running turn. */
  interrupting?: boolean
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
  cause: Cause
  error?: string
  /** How many times the bridge resumed the thread before this end. */
  resumes?: number
  final: string
  durationMs: number
  usage?: Usage
  compactions: number
}
type State = { seq: number; threads: Record<string, Thread>; events: Event[] }
/** A start the budget would hold past the patience: no thread was made. */
export type Refused = { status: 'held'; held: string; opensAt: number }
type Policy = typeof boot

const STATE_DIR = process.env.CODEX_BRIDGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'codex-bridge')
export const SOCKET = join(STATE_DIR, 'bridge.sock')
const STATE = join(STATE_DIR, 'state.json')
const LOCK = join(STATE_DIR, 'serve.lock')
// The daemon's own output (a crash): bridge.log stays one JSON line per event.
const OUT = join(STATE_DIR, 'bridge.err')
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const AGENTS = process.env.CODEX_BRIDGE_AGENTS ?? join(CODEX_HOME, 'agents')
// The command that speaks the app-server protocol on stdio; a test points it at a fake.
const CODEX = (process.env.CODEX_BRIDGE_CODEX ?? 'codex app-server').split(' ')
const FAMILIES = ['luna', 'sol', 'terra', 'astra']
const KEEP_MS = 14 * 24 * 60 * 60e3
// How often latched turns are tried against the budget, and how long a started
// turn's admitted cost counts before the live burn shows it.
const PUMP_MS = 2 * 60e3
const RECENT_MS = 5 * 60e3
// Usage older than this is read again before a budget decision.
const USAGE_MS = 60e3
const STEPS = 12
/** Minutes a latched turn may wait before its role moves to Claude; `codex-bridge wait` reads it as it stands at its start. */
export const PATIENCE_MIN = boot.PATIENCE_MIN
/** The policy's files: a change to one reloads it, and drains nothing. */
const POLICY = join(import.meta.dir, 'policy.ts')
const policyFiles = (policy: string) => [policy, join(dirname(policy), 'budget.ts')]
/** The daemon's core: a change to it drains the daemon. */
const CORE = [import.meta.path]
const stamp = (files: readonly string[]) => files.map(f => statSync(f).mtimeMs).join('-')

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

/** The model Codex runs when none is named. */
function configured(): string | undefined {
  try {
    return (Bun.TOML.parse(readFileSync(join(CODEX_HOME, 'config.toml'), 'utf8')) as { model?: string }).model
  } catch {
    return undefined
  }
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
  private lastLimits: Limits | null = null
  private limitsAt = 0
  /**
   * Set when the source changed: a new turn is latched (status `queued`) and
   * not started, so the daemon hands over once the running ones end; the next
   * daemon runs the latched turns.
   */
  draining = false
  private slugs: string[] | undefined
  /** Turns this daemon started lately, with their admitted cost (%/h), until the live burn shows them. */
  private recent: { at: number; pctph: number }[] = []
  /** Starts and the pump run one at a time, so two turns never take the same room. */
  private chain: Promise<unknown> = Promise.resolve()
  /** The last rate admission's answer, for GET /budget. */
  private admitted: { at: number; ok?: boolean; line: string } | undefined
  /** The policy as last loaded, and the mtimes of its files then. */
  private rules: Policy = boot
  private rulesAt = ''
  readonly server: AppServer

  constructor(
    private file = STATE,
    private policy = POLICY,
  ) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { seq: 0, threads: {}, events: [] }
    // A session that never came back for its events (a `-p` run) leaves them; they go after two weeks.
    const kept = Date.now() - KEEP_MS
    this.state.events = this.state.events.filter(event => event.at > kept)
    for (const [id, thread] of Object.entries(this.state.threads)) if (thread.updatedAt < kept) delete this.state.threads[id]
    // A turn that was running when the last daemon stopped has no child to finish it.
    for (const thread of Object.values(this.state.threads)) if (thread.status === 'running') this.finish(thread, 'failed', 'codex-bridge restarted', 0, 'drain-interrupt')
    this.server = new AppServer(
      (method, params) => this.notify(method, params),
      () => {
        for (const thread of Object.values(this.state.threads))
          if (thread.status === 'running') this.finish(thread, 'failed', 'codex app-server exited', 0, 'app-server-exit')
      },
    )
  }

  /** Appends one event to bridge.log, with the thread's unit and round when it names one. */
  record(event: string, thread?: Thread, fields: Record<string, unknown> = {}) {
    const about = thread && {
      thread: thread.id,
      owner: thread.owner,
      unit: thread.unit,
      round: thread.round,
      role: thread.role,
      model: thread.model,
      turn: thread.turns,
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(join(dirname(this.file), 'bridge.log'), JSON.stringify({ at: new Date().toISOString(), event, ...about, ...fields }) + '\n')
    } catch {
      // A full disk loses the log line, never the turn.
    }
  }

  /**
   * The policy as its files stand: loaded again, under a new version, once
   * policy.ts or budget.ts changed. One that does not load leaves the last in force.
   */
  async refresh(): Promise<Policy> {
    const at = stamp(policyFiles(this.policy))
    if (at === this.rulesAt) return this.rules
    // The first load is no change: only a reload goes to the log.
    const reload = this.rulesAt !== ''
    this.rulesAt = at
    try {
      this.rules = await import(`${this.policy}?v=${at}`)
      if (reload) this.record('policy', undefined, { version: at })
    } catch (error) {
      this.record('policy', undefined, { version: at, error: (error as Error).message })
    }
    return this.rules
  }

  /** From now on new turns latch, so the daemon hands over once none runs. */
  drain() {
    if (this.draining) return
    this.draining = true
    this.record('drain')
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

  /**
   * Ends a turn. One the infrastructure ended is resumed while the policy
   * allows, and its owner hears nothing yet; any other end is an event for its owner.
   */
  private finish(thread: Thread, status: Exclude<Thread['status'], 'running'>, error: string | undefined, durationMs: number, cause: Cause) {
    thread.status = status
    thread.turnId = undefined
    thread.interrupting = undefined
    thread.updatedAt = Date.now()
    this.record('end', thread, { status, cause, error, durationMs })
    const tries = thread.resumes ?? 0
    const resume = this.rules.resume(cause, tries)
    if (resume) {
      thread.resumes = tries + 1
      this.latch(thread, resume.prompt, resume.why)
      thread.notBefore = thread.opensAt = Date.now() + resume.waitMs
      this.record('resume', thread, { cause, try: tries + 1, notBefore: new Date(thread.notBefore).toISOString() })
      this.save()
      setTimeout(() => void this.pump(), resume.waitMs + 1e3).unref?.()
      return
    }
    thread.resumes = undefined
    this.state.events.push({
      seq: ++this.state.seq,
      at: thread.updatedAt,
      owner: thread.owner,
      threadId: thread.id,
      description: thread.description,
      model: thread.model,
      effort: thread.effort,
      status: status === 'idle' ? 'completed' : status,
      cause,
      error,
      ...(tries > 0 && { resumes: tries }),
      final: thread.final ?? '',
      durationMs,
      usage: thread.usage,
      compactions: thread.compactions,
    })
    this.save()
  }

  notify(method: string, params: any) {
    if (method === 'account/rateLimits/updated') {
      this.lastLimits = { ...this.lastLimits, ...params.rateLimits }
      this.limitsAt = Date.now()
    }
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
      const error: string | undefined = turn.error?.message
      this.finish(thread, status, error, turn.durationMs ?? 0, this.rules.cause(status, error, !!thread.interrupting))
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
  // answer that names it, before this continuation runs. A draining daemon
  // latches the turn instead; `runQueued` on the next daemon starts it, as the
  // same turn number.
  private async turn(thread: Thread, prompt: string, count = true) {
    if (this.draining) return this.latch(thread, prompt, this.rules.DRAINING)
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
    if (count) thread.turns++
    thread.updatedAt = Date.now()
    this.record('start', thread)
    this.save()
    return thread
  }

  /** Holds a turn until the pump starts it, as the thread's next turn. */
  private latch(thread: Thread, prompt: string, why: string, opensAt?: number) {
    thread.status = 'queued'
    thread.queued = prompt
    thread.held = why
    thread.opensAt = opensAt
    thread.queuedAt = Date.now()
    thread.notBefore = undefined
    thread.final = undefined
    thread.live = undefined
    thread.turns++
    thread.updatedAt = Date.now()
    this.record('latch', thread, { reason: why, opensAt: opensAt && new Date(opensAt).toISOString() })
    this.save()
    return thread
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Why the policy holds one more turn of `thread` now, and until when; undefined when it may start. */
  private async hold(rules: Policy, thread: Asking): Promise<Hold | undefined> {
    const now = Date.now()
    this.recent = this.recent.filter(r => r.at > now - RECENT_MS)
    const reserve = this.recent.reduce((n, r) => n + r.pctph, 0)
    const decided = await rules.decide(thread, await this.limits(), reserve, now)
    if (decided.admitted) this.admitted = { at: now, ...decided.admitted }
    if (decided.adds && !decided.hold) this.recent.push({ at: now, pctph: decided.adds })
    return decided.hold
  }

  /** Why a new turn waits: the drain, a starving latched turn, or the budget; undefined when it starts now. */
  private async wait(rules: Policy, thread: Asking): Promise<Hold | undefined> {
    if (this.draining) return { why: rules.DRAINING }
    const first = this.queue(rules).find(t => rules.starving(t, Date.now()))
    if (first) return rules.behind(first)
    return this.hold(rules, thread)
  }

  /** A turn now, or latched until the budget has room. */
  private enqueue(thread: Thread, prompt: string) {
    return this.serial(async () => {
      const held = await this.wait(await this.refresh(), thread)
      if (held) return this.latch(thread, prompt, held.why, held.opensAt)
      await this.load(thread)
      return this.turn(thread, prompt)
    })
  }

  /** The latched turns due now, in the policy's order. */
  private queue(rules: Policy) {
    const now = Date.now()
    return rules.order(
      Object.values(this.state.threads).filter(t => t.status === 'queued' && (t.notBefore ?? 0) <= now),
      now,
    )
  }

  /** Starts each latched turn the budget has room for; a held one waits without holding the rest, until it starves. */
  pump() {
    return this.serial(async () => {
      const rules = await this.refresh()
      for (const thread of this.queue(rules)) {
        if (this.draining) return
        const held = await this.hold(rules, thread)
        if (held) {
          if (held.why !== thread.held || held.opensAt !== thread.opensAt) {
            if (held.why !== thread.held) this.record('hold', thread, { reason: held.why, opensAt: held.opensAt && new Date(held.opensAt).toISOString() })
            thread.held = held.why
            thread.opensAt = held.opensAt
            this.save()
          }
          if (rules.starving(thread, Date.now())) return
          continue
        }
        const prompt = thread.queued ?? ''
        thread.queued = undefined
        thread.held = undefined
        thread.opensAt = undefined
        thread.queuedAt = undefined
        thread.notBefore = undefined
        try {
          await this.load(thread)
          await this.turn(thread, prompt, false)
        } catch (error) {
          this.finish(thread, 'failed', `the latched turn did not start: ${(error as Error).message}`, 0, 'error')
        }
      }
    })
  }

  async start(input: {
    owner: string
    description: string
    prompt: string
    cwd: string
    role?: Role
    unit?: string
    round?: number
    model?: string
    effort?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  }): Promise<Thread | Refused> {
    const model = await this.model(input.model)
    const agent = input.role ? roleAgent(input.role) : undefined
    const effort = input.effort ?? agent?.effort
    return this.serial(async () => {
      const rules = await this.refresh()
      const held = await this.wait(rules, { id: '', model: model ?? configured() ?? '', role: input.role, turns: 0, status: 'idle' })
      // A first turn that would wait too long makes no thread: its role moves to Claude now.
      if (held?.opensAt && rules.refuses(held, Date.now())) {
        const opens = new Date(held.opensAt).toISOString()
        this.record('refuse', undefined, { owner: input.owner, unit: input.unit, round: input.round, role: input.role, model, reason: held.why, opensAt: opens })
        return { status: 'held', held: held.why, opensAt: held.opensAt } satisfies Refused
      }
      const thread = await this.open(input, model, agent?.instructions, effort)
      if (held) return this.latch(thread, input.prompt, held.why, held.opensAt)
      return this.turn(thread, input.prompt)
    })
  }

  /** A new thread on the app-server, with its first turn still to come. */
  private async open(input: Parameters<Bridge['start']>[0], model: string | undefined, instructions: string | undefined, effort: string | undefined) {
    const started = await this.server.call('thread/start', {
      model: model ?? null,
      cwd: input.cwd,
      sandbox: input.sandbox ?? null,
      developerInstructions: instructions ?? null,
      config: effort ? { model_reasoning_effort: effort } : null,
      serviceName: 'codex_bridge',
    })
    const thread: Thread = {
      id: started.thread.id,
      owner: input.owner,
      description: input.description,
      role: input.role,
      unit: input.unit,
      round: input.round,
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
    return thread
  }

  /** The next turn on a thread: the same context and prompt cache, so a fix round is a delta. */
  async send(input: { threadId: string; prompt: string }) {
    const thread = this.thread(input.threadId)
    if (thread.status === 'running') throw new Error(`thread ${thread.id} is running turn ${thread.turnId}; interrupt it first`)
    if (thread.status === 'queued') throw new Error(`thread ${thread.id} has a latched turn (${thread.held}); it starts by itself`)
    return this.enqueue(thread, input.prompt)
  }

  /** A thread an earlier app-server child held is resumed before its turn. */
  private async load(thread: Thread) {
    await this.server.start()
    if (!this.server.loaded.has(thread.id)) {
      await this.server.call('thread/resume', { threadId: thread.id, excludeTurns: true })
      this.server.loaded.add(thread.id)
    }
  }


  async interrupt(input: { threadId: string }) {
    const thread = this.thread(input.threadId)
    if (thread.status === 'queued') {
      thread.queued = undefined
      thread.held = undefined
      thread.opensAt = undefined
      thread.notBefore = undefined
      this.finish(thread, 'interrupted', 'stopped before it started', 0, 'interrupted-by-caller')
      return thread
    }
    if (thread.status !== 'running') return thread
    if (!thread.turnId) throw new Error(`thread ${thread.id} has not started its turn yet`)
    thread.interrupting = true
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

  /** The account's rate-limit windows, read again when older than USAGE_MS; the last known when the read fails. */
  async limits() {
    if (Date.now() - this.limitsAt > USAGE_MS) {
      try {
        const read = await this.server.call('account/rateLimits/read', null)
        this.lastLimits = { ...(read.rateLimitsByLimitId?.codex ?? read.rateLimits), ordinaryUsageAllowed: read.ordinaryUsageAllowed }
      } catch {
        // Offline or an older Codex: keep what the last turn reported.
      }
      this.limitsAt = Date.now()
    }
    return this.lastLimits
  }

  /** Whether a new thread and a next turn fit the account's usage (./budget.ts), and the last rate admission. */
  async budget() {
    const rules = await this.refresh()
    return { ...rules.gates(await this.limits(), Date.now()), admission: this.admitted }
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
        'GET /budget': () => bridge.budget(),
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
  // The turns the last daemon latched, then the budget's room, every PUMP_MS.
  void bridge.pump()
  setInterval(() => void bridge.pump(), PUMP_MS)
  const stop = (handOver = false) => {
    if (handOver) bridge.record('handover')
    bridge.server.stop()
    rmSync(SOCKET, { force: true })
    rmSync(LOCK, { force: true })
    if (handOver) daemon()
    process.exit(0)
  }
  process.on('SIGTERM', () => stop())
  process.on('SIGINT', () => stop())
  const tick = watcher(bridge)
  setInterval(async () => {
    if (await tick()) stop(true)
  }, 30e3)
}

/**
 * The daemon's watch on its source, run every 30 s: true once it should hand
 * over. A policy change only reloads the policy. A core change (a pull)
 * drains: stopping would fail a running turn, so until none runs it latches
 * each new turn, and then it starts the new code itself, which runs them.
 */
export function watcher(bridge: Bridge, core: readonly string[] = CORE) {
  const built = stamp(core)
  return async () => {
    await bridge.refresh()
    if (stamp(core) === built) return false
    bridge.drain()
    return !bridge.busy()
  }
}

// A daemon in its own session, so the caller's exit (a mod's one-shot run, a
// handing-over daemon) never takes it down.
function daemon() {
  mkdirSync(STATE_DIR, { recursive: true })
  const out = openSync(OUT, 'a')
  spawn(process.execPath, [import.meta.path, 'serve'], { stdio: ['ignore', out, out], detached: true }).unref()
}

async function ensure() {
  if (!(await healthy())) {
    daemon()
    for (let i = 0; i < 50 && !(await healthy()); i++) await Bun.sleep(100)
    if (!(await healthy())) throw new Error(`codex-bridge did not start; see ${OUT}`)
  }
  console.log(JSON.stringify({ socket: SOCKET }))
}

/**
 * Waits for a latched turn of `id` to start: 0 once it left `queued`, 3 when the
 * bridge knows no such thread, 4 when it is still latched (or the bridge is down) after `minutes`.
 */
export async function waitStarted(
  id: string,
  minutes = PATIENCE_MIN,
  read: () => Promise<Array<{ id: string; status: string; held?: string; opensAt?: number }> | undefined> = async () =>
    fetch('http://bridge/threads', { unix: SOCKET } as RequestInit).then(r => r.json(), () => undefined),
  every = 15e3,
): Promise<{ code: 0 | 3 | 4; line: string }> {
  const deadline = Date.now() + minutes * 60e3
  let held = 'the bridge is down'
  for (;;) {
    const threads = await read()
    const thread = threads?.find(t => t.id === id)
    if (threads && !thread) return { code: 3, line: `codex-bridge has no thread ${id}` }
    if (thread && thread.status !== 'queued') return { code: 0, line: `started: thread ${id} is ${thread.status}` }
    if (thread) held = thread.held ?? 'latched'
    // A turn that should open past the patience moves now, not at the deadline.
    if (thread?.opensAt && thread.opensAt > deadline)
      return {
        code: 4,
        line: `latched (${held}); it should open about ${new Date(thread.opensAt).toISOString().slice(0, 16).replace('T', ' ')}Z, past ${minutes} min: interrupt it with mcp__codex__interrupt and run this role on Claude instead (orchestrate Families)`,
      }
    if (Date.now() >= deadline)
      return {
        code: 4,
        line: `still latched after ${minutes} min (${held}): interrupt it with mcp__codex__interrupt and run this role on Claude instead (orchestrate Families)`,
      }
    await Bun.sleep(every)
  }
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'serve') await serve()
  else if (command === 'ensure') await ensure()
  else if (command === 'status') {
    const response = await fetch('http://bridge/threads', { unix: SOCKET } as RequestInit).catch(() => undefined)
    console.log(response ? JSON.stringify(await response.json(), null, 2) : 'codex-bridge is not running')
  } else if (command === 'wait' && process.argv[3]) {
    const at = process.argv.indexOf('--patience')
    const out = await waitStarted(process.argv[3], at > 0 ? Number(process.argv[at + 1]) : PATIENCE_MIN)
    console.log(out.line)
    process.exit(out.code)
  } else {
    console.error('usage: codex-bridge ensure | serve | status | wait <thread> [--patience <minutes>]')
    process.exit(2)
  }
}

import type { EngineInterface, Register } from 'claude-code'

// Codex threads as workers, through codex-bridge (../bridge/bridge.ts): one daemon
// per host that holds `codex app-server` open. The tools start, continue and stop
// a thread; a finished turn wakes this session as a message, the way a
// background agent's completion does, so nobody polls.
// Threads belong to the session id, so a reload or a resumed session still gets them.

const POLL_MS = 5e3
const FINAL_CHARS = 6000
const ENSURE = ['sh', '-c', 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" exec codex-bridge ensure']

type Usage = { tokens: number; context: number; window: number }
type Thread = {
  id: string
  description: string
  model: string
  effort?: string
  status: string
  turns: number
  compactions: number
  final?: string
  usage?: Usage
}
type Limits = { primary?: { usedPercent: number; windowDurationMins: number; resetsAt?: number } }
type Event = Omit<Thread, 'final'> & { seq: number; threadId: string; final: string; error?: string; durationMs: number }

let socket: string | undefined
let delivering = false

async function ensure($: EngineInterface) {
  const run = await $.process.run(ENSURE, { timeoutMs: 15e3 })
  if (run.exitCode !== 0) throw new Error(`codex-bridge ensure failed: ${run.stderr.trim() || run.stdout.trim()}`)
  return (JSON.parse(run.stdout) as { socket: string }).socket
}

async function call<T>($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const send = async () => {
    socket ??= await ensure($)
    return $.http.fetch(`http://bridge${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: socket,
    })
  }
  // A daemon that stopped since the last call is started again, once.
  const response = await send().catch(() => {
    socket = undefined
    return send()
  })
  const value = JSON.parse(response.text)
  if (!response.ok) throw new Error(value.error ?? `codex-bridge answered ${response.status}`)
  return value as T
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)
const facts = (t: Thread) =>
  [
    `${t.model}${t.effort ? ` ${t.effort}` : ''}`,
    `${t.turns} turn${t.turns === 1 ? '' : 's'}`,
    t.usage && `${tokens(t.usage.tokens)} tokens`,
    t.usage?.window && `context ${Math.round((100 * t.usage.context) / t.usage.window)}%`,
    t.compactions > 0 && `${t.compactions} compaction${t.compactions === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ')
const line = (t: Thread) => `${t.id} "${t.description}": ${t.status}; ${facts(t)}`

function message(events: Event[], threads: Thread[]) {
  return events
    .map(event => {
      const thread = threads.find(t => t.id === event.threadId)
      const final =
        event.final.length > FINAL_CHARS
          ? `${event.final.slice(0, FINAL_CHARS)}\n[cut at ${FINAL_CHARS} characters]`
          : event.final || '(no final message)'
      return [
        `Codex thread ${event.threadId} "${event.description}" ended its turn: ${event.status}${event.error ? ` (${event.error})` : ''}, ${Math.round(event.durationMs / 60e3)} min; ${thread ? facts(thread) : event.model}.`,
        `Continue it with mcp__codex__send, or leave it. Final message:`,
        final,
      ].join('\n')
    })
    .join('\n\n')
}

// Every finished turn of this session's threads, in one prompt, acked once queued.
async function deliver($: EngineInterface) {
  if (delivering) return
  delivering = true
  try {
    const owner = await $.session.id()
    const events = await call<Event[]>($, 'GET', `/events?owner=${encodeURIComponent(owner)}`)
    if (events.length === 0) return
    const threads = await call<Thread[]>($, 'GET', `/threads?owner=${encodeURIComponent(owner)}`)
    await $.prompt.submit({ text: message(events, threads) })
    await call($, 'POST', '/ack', { owner, seqs: events.map(e => e.seq) })
  } catch (error) {
    $.ui.log(`codex: ${(error as Error).message}`, { to: 'debug' })
  } finally {
    delivering = false
  }
}

const str = (e: object, key: string) => {
  const value = (e as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}
const need = (e: object, key: string) => {
  const value = str(e, key)
  if (!value) throw new Error(`${key} is required`)
  return value
}

const TOOLS = [
  {
    name: 'start',
    description:
      'Starts a Codex thread on this host and runs its first turn in the background. Returns at once with the thread id; ' +
      'when the turn ends, its final message arrives as a message from the codex plugin, so never poll. ' +
      'For an orchestrate role pass `role`: the thread then carries that role agent\'s instructions and effort (~/.codex/agents/orchestrate-<role>.toml). ' +
      '`model` takes a slug, or a family (luna, sol, terra, astra) for its newest release; left out, Codex\'s configured default. ' +
      'The thread runs under the host Codex config (sandbox and approvals included) unless `sandbox` is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Starts like the hand-back line: `<role> <unit> r<N>` (`implementor sheet r1`).' },
        prompt: { type: 'string', description: 'The first message: role, spec path and round, for a role thread.' },
        role: { type: 'string', enum: ['planner', 'implementor', 'reviewer', 'verifier'] },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Overrides the role\'s effort.' },
        cwd: { type: 'string', description: 'Absolute; the session\'s directory by default.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      },
      required: ['description', 'prompt'],
    },
  },
  {
    name: 'send',
    description:
      'Runs the next turn on an idle Codex thread, with its context and prompt cache kept (a round 2 fix is a delta). ' +
      'The answer arrives as a message, like the first turn\'s. Refused while the thread runs a turn.',
    inputSchema: {
      type: 'object',
      properties: { thread: { type: 'string' }, prompt: { type: 'string' } },
      required: ['thread', 'prompt'],
    },
  },
  {
    name: 'interrupt',
    description: 'Stops the running turn of a Codex thread. Its end arrives as a message with status interrupted.',
    inputSchema: { type: 'object', properties: { thread: { type: 'string' } }, required: ['thread'] },
  },
  {
    name: 'threads',
    description:
      "This session's Codex threads: status, model and effort, turns, tokens, context fill and compactions; and the Codex plan's usage window.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

async function answer($: EngineInterface, name: (typeof TOOLS)[number]['name'], e: object): Promise<string> {
  const owner = await $.session.id()
  if (name === 'start') {
    const thread = await call<Thread>($, 'POST', '/start', {
      owner,
      description: need(e, 'description'),
      prompt: need(e, 'prompt'),
      cwd: str(e, 'cwd') ?? (await $.session.cwd()),
      role: str(e, 'role'),
      model: str(e, 'model'),
      effort: str(e, 'effort'),
      sandbox: str(e, 'sandbox'),
    })
    return `Started Codex thread ${thread.id} (${facts(thread)}). Its turn's end arrives as a message; do not poll.`
  }
  if (name === 'send') {
    const thread = await call<Thread>($, 'POST', '/send', { threadId: need(e, 'thread'), prompt: need(e, 'prompt') })
    return `Codex thread ${thread.id} runs turn ${thread.turns}. Its end arrives as a message; do not poll.`
  }
  if (name === 'interrupt') {
    const thread = await call<Thread>($, 'POST', '/interrupt', { threadId: need(e, 'thread') })
    return thread.status === 'running' ? `Interrupting ${thread.id}; its end arrives as a message.` : `${thread.id} is ${thread.status}; nothing to interrupt.`
  }
  const threads = await call<Thread[]>($, 'GET', `/threads?owner=${encodeURIComponent(owner)}`)
  const limits = await call<Limits | null>($, 'GET', '/limits')
  const window = limits?.primary
  return [
    threads.length === 0 ? 'This session has no Codex threads.' : threads.map(line).join('\n'),
    window &&
      `Codex limit: ${window.usedPercent}% of the ${Math.round(window.windowDurationMins / 1440)}-day window used` +
        (window.resetsAt ? `, resets ${new Date(window.resetsAt * 1e3).toISOString().slice(0, 16)}Z` : '') +
        '.',
  ]
    .filter(Boolean)
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const { name, description, inputSchema } of TOOLS) await $.tool.register({ name, description, inputSchema })
    $.clock.every(POLL_MS, () => void deliver($))
    return started
  })

  for (const { name } of TOOLS)
    on('tool.call', { tool: `mcp__codex__${name}` }, async ($, e) => {
      try {
        return { result: await answer($, name, e) }
      } catch (error) {
        return { deny: (error as Error).message }
      }
    })
}

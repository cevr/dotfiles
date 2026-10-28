import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Budget, Row, Thread, View } from '../types'

// Codex threads as workers, through codex-bridge (../bridge/bridge.ts): one daemon
// per host that holds `codex app-server` open. The tools start, continue and stop
// a thread; a finished turn wakes this session as a message, the way a
// background agent's completion does, so nobody polls.
// Threads belong to the session id, so a reload or a resumed session still gets them.
//
// The work shows the way a subagent's does: each start or send call's row draws
// its thread's turn live (what runs now, the last steps, the counts and the plan),
// each running thread has its own line in the prompt footer, under the model
// line, and /codex opens a pane with every thread of the session.
//
// Every turn, a first or a next one, passes the Codex budget in the bridge: a
// turn the budget holds, or one asked while the bridge updates, is latched and
// starts by itself when there is room; its end arrives as a message like any.

const POLL_MS = 5e3
const VIEW_MS = 2e3
const FINAL_CHARS = 6000
const PANE = 'codex'
const ENSURE = ['sh', '-c', 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" exec codex-bridge ensure']

type Event = Omit<Thread, 'final'> & { seq: number; threadId: string; final: string; error?: string; durationMs: number }

const view = atom({ plugin: 'codex', key: 'view' } as const, { at: 0, threads: [] } as View)
const rows = atom({ plugin: 'codex', key: 'rows' } as const, {} as Record<string, Row>)

let socket: string | undefined
let delivering = false
let seen = ''

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

// A bridge from before the budget has no /budget until it hands over to the new source.
const readBudget = ($: EngineInterface) => call<Budget>($, 'GET', '/budget').catch(() => undefined)

/** A thread with a turn running, or latched while the bridge updates. */
const active = (t: Thread) => t.status === 'running' || t.status === 'queued'
// A turn latched while the bridge drains for an update; the new bridge starts it.
const QUEUED = (t: Thread) => (t.status === 'queued' ? `The turn is latched (${t.held ?? 'waiting'}); it starts by itself when there is room. To move the role to Claude if it waits past 10 minutes, run \`codex-bridge wait ${t.id} --patience 10\` in the background. ` : '')

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

// The drawings' copy of this session's threads: written when it changes, and on
// every read while a thread runs, so its clock moves.
async function refresh($: EngineInterface) {
  try {
    const owner = await $.session.id()
    const threads = await call<Thread[]>($, 'GET', `/threads?owner=${encodeURIComponent(owner)}`)
    const budget = await readBudget($)
    const text = JSON.stringify([threads, budget])
    if (text === seen && !threads.some(active)) return
    seen = text
    const at = await $.clock.now()
    await update($, view, () => ({ at, threads, budget }))
  } catch (error) {
    $.ui.log(`codex: ${(error as Error).message}`, { to: 'debug' })
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
      'The thread runs under the host Codex config (sandbox and approvals included) unless `sandbox` is passed. ' +
      'When the Codex budget has no room (the account\'s burn with this turn past the weekly pace, or, when that cannot be measured, weekly use ahead of an even burn), the turn is latched and starts by itself later; the answer says why.',
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
      'The answer arrives as a message, like the first turn\'s. Refused while the thread runs or has a latched turn. ' +
      'A next turn passes the same Codex budget as a first one: without room it is latched (ahead of new threads) and starts by itself.',
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
      "This session's Codex threads: status, model and effort, turns, tokens, context fill and compactions; and the Codex budget: each usage window and whether new threads and next turns go on.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

/** The tool's text for the model, and the thread whose turn the call started, if any. */
async function answer($: EngineInterface, name: (typeof TOOLS)[number]['name'], e: object): Promise<{ text: string; started?: Thread }> {
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
    return { text: `${thread.status === 'queued' ? 'Queued' : 'Started'} Codex thread ${thread.id} (${facts(thread)}). ${QUEUED(thread)}Its turn's end arrives as a message; do not poll.`, started: thread }
  }
  if (name === 'send') {
    const thread = await call<Thread>($, 'POST', '/send', { threadId: need(e, 'thread'), prompt: need(e, 'prompt') })
    return { text: `Codex thread ${thread.id} ${thread.status === 'queued' ? 'queued' : 'runs'} turn ${thread.turns}. ${QUEUED(thread)}Its end arrives as a message; do not poll.`, started: thread }
  }
  if (name === 'interrupt') {
    const thread = await call<Thread>($, 'POST', '/interrupt', { threadId: need(e, 'thread') })
    return { text: thread.status === 'running' ? `Interrupting ${thread.id}; its end arrives as a message.` : `${thread.id} is ${thread.status}; nothing to interrupt.` }
  }
  const threads = await call<Thread[]>($, 'GET', `/threads?owner=${encodeURIComponent(owner)}`)
  const budget = await readBudget($)
  return {
    text: [
      threads.length === 0 ? 'This session has no Codex threads.' : threads.map(line).join('\n'),
      budget?.summary ?? 'Codex budget: this bridge predates it; it starts when the bridge hands over to the new source.',
      // The even line decides only when the rate admission could not tell.
      budget && !budget.start.ok && budget.admission?.ok === undefined && `New threads: ${budget.start.reason}.`,
      budget?.admission && `Last admission: ${budget.admission.line}`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

// A tool call's answer; a start or send call's row is tied to the turn it began.
async function run($: EngineInterface, name: (typeof TOOLS)[number]['name'], e: { tool_use_id: string }) {
  try {
    const { text, started } = await answer($, name, e)
    if (started) {
      const row: Row = { thread: started.id, turn: started.turns }
      await update($, rows, all => ({ ...all, [e.tool_use_id]: row }))
      void refresh($)
    }
    return { result: text }
  } catch (error) {
    return { deny: (error as Error).message }
  }
}

// ── Drawing ──

const ROW_TOOLS = new Set(['mcp__codex__start', 'mcp__codex__send'])

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1e3))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const counts = (t: Thread) => {
  const live = t.live
  const parts = live ? [plural(live.commands, 'command'), plural(live.edits, 'edit'), live.tools > 0 && plural(live.tools, 'tool')] : []
  if (t.usage?.window) parts.push(`context ${Math.round((100 * t.usage.context) / t.usage.window)}%`)
  return parts.filter(Boolean).join(' · ')
}
// A thread from a bridge that keeps no live record started its turn when it was last updated.
const state = (t: Thread, at: number) =>
  t.status === 'running'
    ? `running ${clock(at - (t.live?.since ?? t.updatedAt))}`
    : t.status === 'queued'
      ? `latched ${clock(at - t.updatedAt)}: ${t.held ?? 'waiting'}`
      : t.status === 'idle'
        ? 'done'
        : t.status
const planLine = (t: Thread) => {
  const plan = t.live?.plan
  if (!plan?.length) return undefined
  const done = plan.filter(p => p.status === 'completed').length
  const now = plan.find(p => p.status === 'inProgress')
  return `plan ${done}/${plan.length}${now ? `: ${now.step}` : ''}`
}

const doing = (t: Thread) => Object.values(t.live?.running ?? {}).at(-1) ?? t.live?.steps.at(-1)?.text

/** A running thread's footer line: its name, clock, counts and what it does now. */
const footerLine = (t: Thread, at: number) => {
  const now = doing(t)
  return `◆ codex ${t.description} · ${state(t, at)} · ${counts(t)}${now ? ` · ▸ ${now}` : ''}`
}
const FOOTER_LINES = 6

type Ui = ReturnType<EngineInterface['ui']['resolve']>

/** One thread's turn: the head line, the counts, the plan, what runs now and the last `steps` steps. */
function ThreadView({ ui, t, at, steps }: { ui: Ui; t: Thread; at: number; steps: number }) {
  const { Box, Text } = ui
  const live = t.live
  const plan = planLine(t)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>Codex</Text> {t.description} <Text dimColor>· {t.model}{t.effort ? ` ${t.effort}` : ''} · turn {t.turns} · {state(t, at)}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">  {counts(t) || 'no work yet'}</Text>
      {plan && <Text dimColor wrap="truncate-end">  {plan}</Text>}
      {Object.values(live?.running ?? {}).map(text => (
        <Text color="cyan" wrap="truncate-end">  ▸ {text}</Text>
      ))}
      {(live?.steps ?? []).slice(-steps).map(step => (
        <Text color={step.failed ? 'red' : undefined} dimColor={!step.failed} wrap="truncate-end">  {step.failed ? '✗' : '✓'} {step.text}</Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const { name, description, inputSchema } of TOOLS) await $.tool.register({ name, description, inputSchema })
    await $.command.register({ name: 'codex', description: "Show this session's Codex threads and their live work in a pane" })
    $.clock.every(POLL_MS, () => void deliver($))
    $.clock.every(VIEW_MS, () => void refresh($))
    // An earlier version pinned a status line; the footer lines replace it.
    $.ui.status(undefined)
    void refresh($)
    return started
  })

  on('tool.call', { tool: 'mcp__codex__start' }, ($, e) => run($, 'start', e))
  on('tool.call', { tool: 'mcp__codex__send' }, ($, e) => run($, 'send', e))
  on('tool.call', { tool: 'mcp__codex__interrupt' }, ($, e) => run($, 'interrupt', e))
  on('tool.call', { tool: 'mcp__codex__threads' }, ($, e) => run($, 'threads', e))

  on('command.run', { command: 'codex' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Codex threads' })
    return { text: isPlaced ? 'Codex pane opened.' : 'Codex pane opens when the terminal is wide enough.' }
  })

  // A start or send call's row draws its turn live; a later turn sends the reader on.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!ROW_TOOLS.has(e.props.tool) || e.props.isErrored) return next(e)
    const row = (await read($, rows))[e.props.tool_use_id]
    const { at, threads } = await read($, view)
    const t = row && threads.find(one => one.id === row.thread)
    if (!row || !t) return next(e)
    const ui = $.ui.resolve(e)
    if (row.turn !== t.turns) {
      return <ui.Text dimColor>Codex {t.description}: turn {row.turn} ended; the thread is on turn {t.turns} ({state(t, at)}).</ui.Text>
    }
    return <ThreadView ui={ui} t={t} at={at} steps={e.props.isExpanded ? 12 : 3} />
  })

  // One line for each running thread, under the footer the engine and other plugins draw.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const under = await next(e)
    const { at, threads } = await read($, view)
    const running = threads.filter(active)
    if (running.length === 0) return under
    const { Box, Text } = $.ui.resolve(e)
    const shown = running.length > FOOTER_LINES ? running.slice(0, FOOTER_LINES - 1) : running
    return (
      <Box flexDirection="column">
        {under}
        {shown.map(t => (
          <Text dimColor wrap="truncate-end">{footerLine(t, at)}</Text>
        ))}
        {shown.length < running.length && <Text dimColor>◆ codex: {running.length - shown.length} more running · /codex</Text>}
      </Box>
    )
  })

  // Every thread of the session, running first, then the latest.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { at, threads, budget } = await read($, view)
    const head = budget && <Text dimColor={budget.start.ok} color={budget.start.ok ? undefined : 'yellow'}>{budget.summary}</Text>
    if (threads.length === 0) return <Box flexDirection="column">{head}<Text dimColor>This session has no Codex threads.</Text></Box>
    const sorted = [...threads].sort((a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt)
    const ui = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {head}
        {sorted.slice(0, 6).map(t => (
          <ThreadView ui={ui} t={t} at={at} steps={8} />
        ))}
      </Box>
    )
  })
}

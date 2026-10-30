// A stand-in for `codex app-server` in the bridge's tests: it answers the requests
// the bridge makes and finishes every turn at once with the reply `done: <prompt>`.
// A prompt with the word `hang` keeps its turn running until it is interrupted;
// one that starts with `work` shows work items first (see `work`). A prompt with
// `capacity<N>` fails that turn and the thread's next N-1 ones as Codex does when
// the model is at capacity. A `deaf` prompt hangs too, and refuses the first
// interrupt of its turn. A `crash` prompt makes the fake exit before it answers.
// Every request it gets is appended to $FAKE_LOG, one JSON line each.
// It reads the account's usage from $FAKE_LIMITS (a rate-limit snapshot as JSON), when set.
import { appendFileSync } from 'node:fs'

let threads = 0
let turns = 0
const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
const log = (message: unknown) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(message) + '\n')

const complete = (threadId: string, turnId: string, status: string, text?: string, error: string | null = null) => {
  const item = { type: 'agentMessage', id: `m${turnId}`, text: text ?? '', phase: 'final_answer' }
  if (text) out({ method: 'item/completed', params: { threadId, turnId, item } })
  out({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 600, outputTokens: 100, reasoningOutputTokens: 0 },
        last: { totalTokens: 500, inputTokens: 450, cachedInputTokens: 300, outputTokens: 50, reasoningOutputTokens: 0 },
        modelContextWindow: 1000,
      },
    },
  })
  out({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 3 } } } })
  out({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, items: text ? [item] : [], status, error: error && { message: error }, durationMs: 42 } },
  })
}

// A `work` prompt runs a failing command and an edit, and leaves one search running, before it finishes.
const work = (threadId: string, turnId: string) => {
  const item = (event: string, item: unknown) => out({ method: `item/${event}`, params: { threadId, turnId, item } })
  const command = { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'bun test'", status: 'inProgress', exitCode: null }
  item('started', command)
  item('completed', { ...command, status: 'completed', exitCode: 1 })
  item('started', { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/src/a.ts' }], status: 'inProgress' })
  item('completed', { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/src/a.ts' }], status: 'completed' })
  item('started', { type: 'webSearch', id: 'w1', query: 'effect deferred' })
  out({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: null, plan: [{ step: 'fix', status: 'completed' }, { step: 'test', status: 'inProgress' }] } })
}

let buffer = ''
const hanging = new Map<string, string>()
const busy = new Map<string, number>()
const deaf = new Set<string>()
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (message.id === undefined) continue
    log(message)
    const { id, method, params } = message
    if (method === 'initialize') out({ id, result: { userAgent: 'fake' } })
    else if (method === 'model/list')
      out({ id, result: { data: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol'].map(model => ({ model })) } })
    else if (method === 'thread/start')
      out({ id, result: { thread: { id: `t${++threads}` }, model: params.model ?? 'gpt-6.1-sol', reasoningEffort: params.config?.model_reasoning_effort ?? null } })
    else if (method === 'account/rateLimits/read' && process.env.FAKE_LIMITS)
      out({ id, result: { rateLimits: JSON.parse(process.env.FAKE_LIMITS), rateLimitsByLimitId: null, ordinaryUsageAllowed: true } })
    else if (method === 'thread/resume') out({ id, result: { thread: { id: params.threadId } } })
    else if (method === 'turn/start') {
      const turnId = `u${++turns}`
      const text = params.input[0].text as string
      if (/\bcrash\b/.test(text)) process.exit(1)
      out({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
      if (text.startsWith('work')) work(params.threadId, turnId)
      const fails = /\bcapacity(\d+)\b/.exec(text)
      if (fails) busy.set(params.threadId, Number(fails[1]))
      if (busy.get(params.threadId)) {
        busy.set(params.threadId, busy.get(params.threadId)! - 1)
        complete(params.threadId, turnId, 'failed', undefined, 'Selected model is at capacity. Please try a different model.')
      } else if (/\b(hang|deaf)\b/.test(text)) {
        hanging.set(params.threadId, turnId)
        if (/\bdeaf\b/.test(text)) deaf.add(turnId)
      }
      else complete(params.threadId, turnId, 'completed', `done: ${text}`)
    } else if (method === 'turn/interrupt' && deaf.delete(params.turnId)) out({ id, error: { code: -32000, message: 'interrupt refused' } })
    else if (method === 'turn/interrupt') {
      out({ id, result: {} })
      hanging.delete(params.threadId)
      complete(params.threadId, params.turnId, 'interrupted')
    } else out({ id, error: { code: -32601, message: `fake has no ${method}` } })
  }
}

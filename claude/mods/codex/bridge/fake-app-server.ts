// A stand-in for `codex app-server` in the bridge's tests: it answers the requests
// the bridge makes and finishes every turn at once with the reply `done: <prompt>`.
// A prompt that starts with `hang` keeps its turn running until it is interrupted.
// Every request it gets is appended to $FAKE_LOG, one JSON line each.
import { appendFileSync } from 'node:fs'

let threads = 0
let turns = 0
const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
const log = (message: unknown) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(message) + '\n')

const complete = (threadId: string, turnId: string, status: string, text?: string) => {
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
    params: { threadId, turn: { id: turnId, items: text ? [item] : [], status, error: null, durationMs: 42 } },
  })
}

let buffer = ''
const hanging = new Map<string, string>()
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
    else if (method === 'thread/resume') out({ id, result: { thread: { id: params.threadId } } })
    else if (method === 'turn/start') {
      const turnId = `u${++turns}`
      const text = params.input[0].text as string
      out({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
      if (text.startsWith('hang')) hanging.set(params.threadId, turnId)
      else complete(params.threadId, turnId, 'completed', `done: ${text}`)
    } else if (method === 'turn/interrupt') {
      out({ id, result: {} })
      hanging.delete(params.threadId)
      complete(params.threadId, params.turnId, 'interrupted')
    } else out({ id, error: { code: -32601, message: `fake has no ${method}` } })
  }
}

// The Anthropic Messages API, reached through a transport: the pool's Claude
// accounts by default (pool.ts), the API key in OpenCode's auth file with
// `--api-key`. No token or key is ever printed or written. Every request goes
// through `Ledger.charge`, which counts tokens and API-price dollars and
// refuses a request once the run's cap is spent.
import { homedir } from "node:os"
import { join } from "node:path"
import { type Pool, PoolLimit } from "./pool.ts"

/**
 * The models the eval may call, with their USD prices per million tokens (platform.claude.com pricing, 2026-10-07;
 * Haiku 5.5 for prompts up to 100k tokens; Opus 5.5 from models.dev, 2026-11-09). The newest Haiku is the default; the
 * older one is there for when the key cannot reach it. Opus is the model production runs; a run on it needs the
 * owner's approval, given with `--owner-approved-opus` (round 5 had it, for one round).
 */
export const MODELS = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
} as const
export type ModelId = keyof typeof MODELS

/** The models that need the owner's approval for a run. */
const APPROVAL = new Set<string>(["claude-opus-5-5"])

export let MODEL: ModelId = "claude-haiku-5-5"

export const useModel = (id: string, approved = false): void => {
  if (!(id in MODELS)) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`)
  if (APPROVAL.has(id) && !approved) throw new Error(`${id} needs the owner's approval for this run: pass --owner-approved-opus only when the owner gave it; otherwise use a Haiku`)
  MODEL = id as ModelId
}

export interface Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })

export const addUsage = (into: Usage, from: Usage): Usage => {
  into.input += from.input
  into.output += from.output
  into.cacheWrite += from.cacheWrite
  into.cacheRead += from.cacheRead
  return into
}

export const costOf = (usage: Usage, model: ModelId = MODEL): number => {
  const price = MODELS[model]
  return (usage.input * price.input + usage.output * price.output + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead) / 1e6
}

export class CapReached extends Error {
  constructor(spent: number, cap: number) {
    super(`cost cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`)
  }
}

/** The run's spend, shared by every episode. */
export class Ledger {
  readonly usage = emptyUsage()
  requests = 0
  constructor(readonly capUsd: number) {}
  get spent(): number {
    return costOf(this.usage)
  }
  /** Throws once the cap is spent, before a request goes out. */
  guard(): void {
    if (this.spent >= this.capUsd) throw new CapReached(this.spent, this.capUsd)
  }
  charge(usage: Usage): void {
    addUsage(this.usage, usage)
    this.requests += 1
  }
  line(): string {
    const u = this.usage
    return `requests ${this.requests} · in ${u.input} · out ${u.output} · cache write ${u.cacheWrite} · cache read ${u.cacheRead} · $${this.spent.toFixed(4)} of $${this.capUsd.toFixed(2)}`
  }
}

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string }

export interface Message {
  role: "user" | "assistant"
  content: string | Array<Block>
}

export interface Response {
  content: Array<Block>
  stop_reason: string
  usage: Usage
}

/**
 * How a Messages body reaches Anthropic: the pool's accounts (pool.ts, the default) or, with `--api-key`, the
 * API key. `send` answers the HTTP status and body; `record` gives the pool the step's price.
 */
export interface Transport {
  readonly send: (sessionID: string, body: Record<string, unknown>) => Promise<{ readonly status: number; readonly text: string }>
  readonly record?: (sessionID: string, cost: number) => void
}

/** The pool's accounts as the transport (pool.ts). */
export const poolTransport = (pool: Pool): Transport => ({
  send: (sessionID, body) => pool.send(sessionID, String(body["model"]), body),
  record: (sessionID, cost) => pool.record(sessionID, cost),
})

/** The API key in OpenCode's auth file, read at the first request and never printed: the explicit fallback. */
export const keyTransport = (fetcher: typeof fetch = fetch): Transport => {
  let key: string | undefined
  const apiKey = async (): Promise<string> => {
    if (key !== undefined) return key
    const auth = (await Bun.file(join(homedir(), ".local/share/opencode/auth.json")).json()) as { anthropic?: { key?: string } }
    const found = auth.anthropic?.key
    if (typeof found !== "string" || found === "") throw new Error("no anthropic.key in ~/.local/share/opencode/auth.json")
    key = found
    return key
  }
  return {
    send: async (_sessionID, body) => {
      const response = await fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": await apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return { status: response.status, text: await response.text() }
    },
  }
}

let transport: Transport | undefined
export const useTransport = (next: Transport): void => {
  transport = next
}

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Tests wait no real time. */
export const useSleep = (next: (ms: number) => Promise<void>): void => {
  sleep = next
}

/** A pool hold this close is waited out; a longer one stops the run. */
const WAIT_FOR_POOL_MS = 60_000

/**
 * One Messages request of the session `session`. `system` and `tools` are the static prefix: the last system block
 * carries a cache breakpoint, and the top-level `cache_control` caches the conversation as it grows.
 */
export const create = async (
  ledger: Ledger,
  body: {
    system: Array<{ type: "text"; text: string }>
    tools: ReadonlyArray<unknown>
    messages: ReadonlyArray<Message>
    maxTokens?: number
    session?: string
  },
): Promise<Response> => {
  if (transport === undefined) throw new Error("no transport: call useTransport first (eval.ts does)")
  const session = body.session ?? "eval"
  const system = body.system.map((block, index) => (index === body.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block))
  const payload = {
    model: MODEL,
    max_tokens: body.maxTokens ?? 4096,
    cache_control: { type: "ephemeral" },
    system,
    tools: body.tools,
    messages: body.messages,
  }
  for (let attempt = 0; ; attempt++) {
    ledger.guard()
    const sent = await transport.send(session, payload).catch(async (error: unknown) => {
      // Every account held for a short while (a transient rate limit): wait it out; longer stops the run.
      if (!(error instanceof PoolLimit) || error.retryAt === undefined || attempt >= 5) throw error
      const wait = error.retryAt - Date.now()
      if (wait > WAIT_FOR_POOL_MS) throw error
      await sleep(Math.max(wait, 0) + 250)
      return undefined
    })
    if (sent === undefined) continue
    if (sent.status >= 200 && sent.status < 300) {
      const json = JSON.parse(sent.text) as {
        content: Array<Block>
        stop_reason: string
        usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
      }
      const usage: Usage = {
        input: json.usage.input_tokens,
        output: json.usage.output_tokens,
        cacheWrite: json.usage.cache_creation_input_tokens ?? 0,
        cacheRead: json.usage.cache_read_input_tokens ?? 0,
      }
      ledger.charge(usage)
      transport.record?.(session, costOf(usage))
      return { content: json.content, stop_reason: json.stop_reason, usage }
    }
    const retryable = sent.status === 429 || sent.status === 529 || sent.status >= 500
    if (!retryable || attempt >= 5) throw new Error(`Messages API ${sent.status}: ${sent.text.slice(0, 500)}`)
    await sleep(2000 * 2 ** attempt)
  }
}

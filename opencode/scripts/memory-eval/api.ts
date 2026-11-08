// The Anthropic Messages API, called directly with fetch. The key is read at
// runtime from OpenCode's auth file and never printed or written. Every request
// goes through `Ledger.charge`, which counts tokens and dollars and refuses a
// request once the run's cap is spent.
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The models the eval may call, Haiku only, with their USD prices per million tokens (platform.claude.com pricing,
 * 2026-10-07; Haiku 5.5 for prompts up to 100k tokens). The newest Haiku is the default; the older one is there for when
 * the key cannot reach it.
 */
export const MODELS = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
} as const
export type ModelId = keyof typeof MODELS

export let MODEL: ModelId = "claude-haiku-5-5"

export const useModel = (id: string): void => {
  if (!(id in MODELS)) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}: this eval calls Haiku only`)
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

let key: string | undefined
const apiKey = async (): Promise<string> => {
  if (key !== undefined) return key
  const auth = (await Bun.file(join(homedir(), ".local/share/opencode/auth.json")).json()) as { anthropic?: { key?: string } }
  const found = auth.anthropic?.key
  if (typeof found !== "string" || found === "") throw new Error("no anthropic.key in ~/.local/share/opencode/auth.json")
  key = found
  return key
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One Messages request. `system` and `tools` are the static prefix: the last system block carries a cache breakpoint,
 * and the top-level `cache_control` caches the conversation as it grows.
 */
export const create = async (
  ledger: Ledger,
  body: { system: Array<{ type: "text"; text: string }>; tools: ReadonlyArray<unknown>; messages: ReadonlyArray<Message>; maxTokens?: number },
): Promise<Response> => {
  const system = body.system.map((block, index) => (index === body.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block))
  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: body.maxTokens ?? 4096,
    cache_control: { type: "ephemeral" },
    system,
    tools: body.tools,
    messages: body.messages,
  })
  for (let attempt = 0; ; attempt++) {
    ledger.guard()
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": await apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: payload,
    })
    if (response.ok) {
      const json = (await response.json()) as {
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
      return { content: json.content, stop_reason: json.stop_reason, usage }
    }
    const text = await response.text()
    const retryable = response.status === 429 || response.status === 529 || response.status >= 500
    if (!retryable || attempt >= 5) throw new Error(`Messages API ${response.status}: ${text.slice(0, 500)}`)
    await sleep(2000 * 2 ** attempt)
  }
}

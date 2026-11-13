// The host's side of a model request that goes over HTTP to a provider of the
// world (sim/provider.ts): the request OpenCode builds for Anthropic's messages
// API, the reply it reads back from the stream, how it names a failure, and
// when it tries again. Each rule names the fork source it follows and is held
// to real OpenCode by a law in host-laws.ts.
//
// - The request (packages/core/src/session/model-request.ts): `POST
//   <baseURL>/messages`, the `model.request` hook's headers on it, a JSON body
//   of the model, the system prompt, the conversation and the offered tools,
//   streamed. A title request offers no tools.
// - A failure (packages/ai/src/provider-error.ts `classifyProviderFailure`,
//   schema/errors.ts `isRetryable`): `x-should-retry` decides when the
//   response sets it; else a 429 whose words name a plan's usage limit is a
//   quota (not retried), another 429 a rate limit (retried, after its
//   `retry-after`), a 401 or 403 an authentication failure (not retried), a
//   5xx the provider's (retried), any other 4xx the request's (not retried).
// - The retry (packages/core/src/model-retry.ts, session/runner/retry.ts):
//   gaps from 2 s doubling to at most 10 s, each scaled by a jitter in
//   [0.8, 1.2), never shorter than the provider's `retry-after` (capped at 15
//   minutes), for at most 10 retries. The `retry` hook sees every failure
//   with the decision, a retryable one's or `retry: false`, and may change
//   it; a negative or non-finite delay it sets takes the policy's.
// - A request an `http.request` hook sends to a data: URL (the host's fetch,
//   Bun's): answered in the process with the URL's data, never by a provider.
import { Effect, Option, Schema } from "effect"
import { below, line, type Runtime } from "./runtime.ts"

/** A failure as the host names it, and whether it may be sent again. */
export interface Failure {
  readonly tag: "QuotaExceeded" | "RateLimit" | "Authentication" | "ProviderInternal" | "InvalidRequest" | "Transport" | "Unknown"
  readonly status: number
  readonly message: string
  readonly retryable: boolean
  /** The wait the provider asked for, ms; 0 for none. */
  readonly retryAfterMs: number
}

/** The usage limit's words on a 429, as the fork's QUOTA_TEXT reads them. */
const QUOTA_TEXT =
  /insufficient[-_\s]?(?:quota|balance)|(?<!token_)quota[-_\s]?exceeded|budget exceeded|usage limit|(?<!rate[-_\s]?)limit exhausted|package has expired|plan does not yet include/i

const RETRY_AFTER_MAX = 15 * 60_000

const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))
const decodeError = Schema.decodeUnknownOption(ErrorBody)

/** A failed response's message: its JSON error's, else its text. */
const messageOf = (status: number, text: string) =>
  Option.match(decodeError(text), {
    onNone: () => `${status} ${text}`.trim(),
    onSome: (body) => body.error.message,
  })

/** `retry-after` in seconds, as ms; 0 when absent or unreadable. */
const retryAfterOf = (headers: Headers) => {
  const seconds = Number(Option.getOrElse(Option.fromNullishOr(headers.get("retry-after")), () => ""))
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(seconds * 1000, RETRY_AFTER_MAX)
}

/** How the host names a failed response, and whether it may go again. */
export const classify = (status: number, headers: Headers, text: string): Failure => {
  const message = messageOf(status, text)
  const retryAfterMs = retryAfterOf(headers)
  const failure = (tag: Failure["tag"], retryable: boolean): Failure => {
    const override = headers.get("x-should-retry")
    let decided = retryable
    if (override === "true") decided = true
    if (override === "false") decided = false
    return { tag, status, message, retryable: decided, retryAfterMs }
  }
  if (status === 402 || (status === 429 && QUOTA_TEXT.test(`${message}\n${text}`))) return failure("QuotaExceeded", false)
  if (status === 401 || status === 403) return failure("Authentication", false)
  if (status === 429) return failure("RateLimit", true)
  if (status === 408 || status === 409 || status >= 500) return failure("ProviderInternal", true)
  return failure("InvalidRequest", false)
}

/** A data: URL of text: its media type and its percent-encoded data. A base64 one is not modelled. */
const DATA_URL = /^data:([^,;]*(?:;charset=[^,;]*)?),(.*)$/s

/**
 * A data: URL's answer, as the host's fetch gives it without the network: a 200 of the URL's data, percent-decoded,
 * typed by its media type (text/plain without one); none for another URL.
 */
export const dataOf = (url: string): Option.Option<Response> =>
  Option.map(Option.fromNullishOr(DATA_URL.exec(url)), (match) => {
    const part = (index: number) => Option.getOrElse(Option.fromNullishOr(match[index]), () => "")
    const type = Option.getOrElse(Option.liftPredicate(part(1), (named) => named !== ""), () => "text/plain;charset=US-ASCII")
    return new Response(decodeURIComponent(part(2)), { status: 200, headers: { "content-type": type } })
  })

/** A request that did not connect: the provider is not where it was sent. */
export const unreachable = (message: string): Failure => ({ tag: "Transport", status: 0, message, retryable: true, retryAfterMs: 0 })

/** The policy's next gap after `retries` retries, or none past the tenth. */
export const gapOf = (runtime: Runtime, retries: number, failure: Failure) => {
  if (retries >= 10) return Option.none<number>()
  const base = Math.min(2_000 * 2 ** retries, 10_000)
  const jittered = Math.ceil(base * (0.8 + below(runtime.world, 400) / 1_000))
  return Option.some(Math.max(jittered, failure.retryAfterMs))
}

/** One item of a reply: text, or one tool call. */
export type Item = { readonly type: "text"; readonly text: string } | { readonly type: "tool"; readonly id: string; readonly name: string; readonly input: Schema.Json }

/** What a reply's stream says. */
export interface Streamed {
  readonly items: ReadonlyArray<Item>
  readonly usage: { readonly input: number; readonly read: number; readonly write: number }
}

const Event = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  content_block: Schema.optional(Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.String), name: Schema.optional(Schema.String), text: Schema.optional(Schema.String) })),
  delta: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String), text: Schema.optional(Schema.String), partial_json: Schema.optional(Schema.String) })),
  message: Schema.optional(
    Schema.Struct({
      usage: Schema.optional(
        Schema.Struct({
          input_tokens: Schema.optional(Schema.Number),
          cache_read_input_tokens: Schema.optional(Schema.Number),
          cache_creation_input_tokens: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
})
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** A server-sent stream of Anthropic's message events, read as the host's AI SDK reads it: the blocks in order, the usage the start reports. */
export const readStream = (text: string): Streamed => {
  const blocks: Array<Block> = []
  const read = { usage: { input: 0, read: 0, write: 0 } }
  for (const data of text.split("\n").filter((row) => row.startsWith("data: ")))
    Option.map(decodeEvent(data.slice("data: ".length)), (event) => {
      if (event.type === "message_start") read.usage = usageOf(event)
      if (event.type === "content_block_start") blocks[event.index ?? blocks.length] = blockOf(event)
      if (event.type === "content_block_delta") Option.map(Option.fromNullishOr(blocks[event.index ?? 0]), (block) => extend(block, event))
    })
  const items = blocks.map((block): Item => {
    if (block.type !== "tool_use") return { type: "text", text: block.text }
    return { type: "tool", id: block.id, name: block.name, input: Option.getOrElse(decodeJson(block.json || "{}"), (): Schema.Json => ({})) }
  })
  return { items, usage: read.usage }
}

/** A content block as the stream builds it. */
interface Block {
  readonly type: string
  readonly id: string
  readonly name: string
  text: string
  json: string
}

/** The usage a `message_start` reports. */
const usageOf = (event: typeof Event.Type) => {
  const usage = event.message?.usage
  return { input: usage?.input_tokens ?? 0, read: usage?.cache_read_input_tokens ?? 0, write: usage?.cache_creation_input_tokens ?? 0 }
}

/** The block a `content_block_start` opens. */
const blockOf = (event: typeof Event.Type): Block => {
  const started = event.content_block
  return { type: started?.type ?? "text", id: started?.id ?? "", name: started?.name ?? "", text: started?.text ?? "", json: "" }
}

/** A `content_block_delta` added to its block. */
const extend = (block: Block, event: typeof Event.Type) => {
  block.text += event.delta?.text ?? ""
  block.json += event.delta?.partial_json ?? ""
}

/** The body the host sends Anthropic's messages API for a request. */
export const bodyOf = (input: {
  readonly model: string
  readonly system: string
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Schema.Json> }>
  readonly tools: ReadonlyArray<string>
}) =>
  line({
    model: input.model,
    max_tokens: 32_000,
    system: [{ type: "text", text: input.system }],
    messages: input.messages,
    ...(input.tools.length > 0 && { tools: input.tools.map((name) => ({ name, description: `the ${name} tool`, input_schema: { type: "object", properties: {} } })) }),
    stream: true,
  })

/** Reads a response's body once: its text. */
export const textOf = (response: Response) => Effect.promise(() => response.text())

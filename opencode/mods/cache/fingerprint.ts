// A model request's prompt as a prompt cache sees it: an ordered list of
// segments, each hashed, so two requests of a session can be compared and the
// first segment that changed named. A cache serves the longest prefix it holds,
// so the first changed segment is where the cache stopped reading.
//
// The order is Anthropic's cache order: the tools, then the system prompt, then
// the messages. Each tool is a segment; each system block, and each system
// message of a chat-completions body, is cut into paragraphs (`system[1] ¶4`),
// so a dynamic line a few thousand tokens in is named, not the whole block;
// each message's content part is a segment. `cache_control` markers are left
// out of every hash: the provider moves them each request and they are not
// part of the cached text, nor is Anthropic's billing stamp, which is no
// segment at all (`BILLING_STAMP_PREFIX`). Only hashes and lengths are kept,
// and the first words of a system paragraph, never a message's content.
import { DEFAULT_TTL_MS, parseTtl } from "./ttl.ts"

/** One hashed piece of a request's prompt. */
export interface Segment {
  /** `tool shell`, `system[1] ¶4`, `messages[12] user part 0 (text)`. */
  readonly label: string
  readonly hash: string
  /** Its serialized length: a token is about four of them. */
  readonly chars: number
  /** The first words of a system paragraph; nothing for a tool or a message. */
  readonly head?: string
}

/** Where a request's prompt first differs from the request before it. */
export interface Change {
  /** The segment of the new request at the first difference; `end of prompt` when the new prompt stops short. */
  readonly segment: string
  /** The previous request's segment at that place, when it was another one. */
  readonly previous?: string
  /** About how many prompt tokens come before it: what the cache could still read. */
  readonly offsetTokens: number
  /** The first words of the changed system paragraph. */
  readonly head?: string
}

/** About four characters to a token. */
export const CHARS_PER_TOKEN = 4

const HEAD_CHARS = 64

/** cyrb53, a fast 53-bit string hash: enough to tell two prompt segments apart, and free of any runtime. */
export const hash = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The value with every `cache_control` key left out, at any depth. */
const withoutMarkers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutMarkers)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) if (key !== "cache_control") out[key] = withoutMarkers(inner)
  return out
}

const segment = (label: string, value: unknown, head?: string): Segment => {
  const text = typeof value === "string" ? value : (JSON.stringify(withoutMarkers(value)) ?? "")
  return { label, hash: hash(text), chars: text.length, ...(head === undefined ? {} : { head }) }
}

const headOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > HEAD_CHARS ? `${flat.slice(0, HEAD_CHARS - 1)}…` : flat
}

/** A system text cut into paragraphs, each its own segment: `<label> ¶1`, `<label> ¶2`, …. */
const paragraphs = (label: string, text: string): ReadonlyArray<Segment> =>
  text.split(/\n{2,}/).map((paragraph, index) => segment(`${label} ¶${index + 1}`, paragraph, headOf(paragraph)))

const textOf = (block: unknown): string | undefined =>
  typeof block === "string" ? block : isRecord(block) && typeof block["text"] === "string" ? block["text"] : undefined

const toolName = (tool: unknown, index: number): string => {
  if (isRecord(tool)) {
    if (typeof tool["name"] === "string") return tool["name"]
    const fn = tool["function"]
    if (isRecord(fn) && typeof fn["name"] === "string") return fn["name"]
  }
  return `#${index}`
}

/**
 * The billing stamp the Claude Code route puts first in the system prompt
 * (mods/anthropic-auth/billing.ts). Anthropic reads it as request metadata and
 * leaves it out of the cache key: a request whose stamp changed at a
 * compaction still read some 24k tokens of system prompt past it (measured in
 * the ledger, 2026-11). It is no segment, so a change of it names nothing.
 */
export const BILLING_STAMP_PREFIX = "x-anthropic-billing-header:"

const systemSegments = (system: unknown): ReadonlyArray<Segment> => {
  if (typeof system === "string") return paragraphs("system[0]", system)
  if (!Array.isArray(system)) return []
  return system.flatMap((block: unknown, index) => {
    const text = textOf(block)
    if (text?.startsWith(BILLING_STAMP_PREFIX)) return []
    return text === undefined ? [segment(`system[${index}]`, block)] : paragraphs(`system[${index}]`, text)
  })
}

const SYSTEM_ROLES = new Set(["system", "developer"])

const messageSegments = (message: unknown, index: number): ReadonlyArray<Segment> => {
  if (!isRecord(message)) return [segment(`messages[${index}]`, message)]
  const role = typeof message["role"] === "string" ? message["role"] : typeof message["type"] === "string" ? message["type"] : "item"
  const label = `messages[${index}] ${role}`
  const content = message["content"]
  // What else the message carries besides its content (tool calls, ids): a segment of its own.
  const { content: _content, ...rest } = message
  const restSegments = Object.keys(rest).some((key) => key !== "role") ? [segment(`${label} fields`, rest)] : []
  if (typeof content === "string")
    return [...(SYSTEM_ROLES.has(role) ? paragraphs(label, content) : [segment(label, content)]), ...restSegments]
  if (!Array.isArray(content)) return [segment(label, message)]
  return [
    ...content.flatMap((part: unknown, partIndex) => {
      const type = isRecord(part) && typeof part["type"] === "string" ? ` (${part["type"]})` : ""
      const text = textOf(part)
      return SYSTEM_ROLES.has(role) && text !== undefined
        ? paragraphs(`${label} part ${partIndex}`, text)
        : [segment(`${label} part ${partIndex}${type}`, part)]
    }),
    ...restSegments,
  ]
}

/**
 * A request body's segments in cache order: its tools, its system prompt
 * (`system`, or `instructions` on OpenAI's Responses API), its messages
 * (`messages`, or `input`). Nothing for a body of another shape.
 */
export const segments = (body: unknown): ReadonlyArray<Segment> => {
  if (!isRecord(body)) return []
  const tools = Array.isArray(body["tools"]) ? body["tools"].map((tool: unknown, index) => segment(`tool ${toolName(tool, index)}`, tool)) : []
  const system = systemSegments(body["system"] ?? body["instructions"])
  const list = Array.isArray(body["messages"]) ? body["messages"] : Array.isArray(body["input"]) ? body["input"] : []
  return [...tools, ...system, ...list.flatMap((message: unknown, index) => messageSegments(message, index))]
}

/**
 * Where `next` first differs from `previous`: the first segment whose hash
 * differs, or the end of `next` when it stops short of `previous`. Undefined
 * when `next` holds all of `previous` unchanged, whatever it adds after it.
 */
export const firstChange = (previous: ReadonlyArray<Segment>, next: ReadonlyArray<Segment>): Change | undefined => {
  let chars = 0
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]
    const after = next[index]
    if (before === undefined) break
    const offsetTokens = Math.round(chars / CHARS_PER_TOKEN)
    if (after === undefined) return { segment: "end of prompt", previous: before.label, offsetTokens }
    if (after.hash !== before.hash)
      return {
        segment: after.label,
        ...(after.label === before.label ? {} : { previous: before.label }),
        offsetTokens,
        ...(after.head === undefined ? {} : { head: after.head }),
      }
    chars += after.chars
  }
  return undefined
}

/** The lifetime a request asks its cache to keep the prompt, and whether it marks the cache itself. */
export interface Lifetime {
  readonly ttlMs: number
  /** The body marks cache breakpoints (Anthropic); else the provider caches on its own (OpenAI). */
  readonly explicit: boolean
}

const markerTtls = (value: unknown, found: Array<string | undefined>): void => {
  if (Array.isArray(value)) {
    for (const inner of value) markerTtls(inner, found)
    return
  }
  if (!isRecord(value)) return
  for (const [key, inner] of Object.entries(value)) {
    if (key === "cache_control" && isRecord(inner)) found.push(typeof inner["ttl"] === "string" ? inner["ttl"] : undefined)
    else markerTtls(inner, found)
  }
}

/** An OpenAI body's request-level cache lifetime, when it names one that parses. */
const requestTtl = (body: unknown): number | undefined => {
  if (!isRecord(body)) return undefined
  const options = body["prompt_cache_options"]
  const ttl = isRecord(options) && typeof options["ttl"] === "string" ? options["ttl"] : body["prompt_cache_retention"]
  return typeof ttl === "string" ? parseTtl(ttl) : undefined
}

/**
 * The lifetime a body's cache markers ask for: the longest `ttl` of its
 * `cache_control` markers, Anthropic's 5 minutes for a marker that names none;
 * `override`, a lifetime another plugin has the request written for (the
 * pool's `x-opencode-cache-ttl`), wins. A body with no marker is cached by its
 * provider's own rules: the request-level lifetime an OpenAI body names
 * (`prompt_cache_options.ttl`, or `prompt_cache_retention: "24h"`, as the
 * fork's packages/ai/src/protocols/utils/cache.ts writes a configured
 * `cache.ttl`), else OpenAI's 30 minutes.
 */
export const lifetime = (body: unknown, override?: string): Lifetime => {
  const found: Array<string | undefined> = []
  markerTtls(body, found)
  const named = override === undefined ? undefined : parseTtl(override)
  if (found.length === 0) return { ttlMs: named ?? requestTtl(body) ?? DEFAULT_TTL_MS.openai, explicit: false }
  const longest = Math.max(...found.map((ttl) => (ttl === undefined ? undefined : parseTtl(ttl)) ?? DEFAULT_TTL_MS.anthropic))
  return { ttlMs: named ?? longest, explicit: true }
}

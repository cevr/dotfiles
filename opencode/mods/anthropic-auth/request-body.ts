// A Messages request body as Claude Code sends it: the billing stamp, Claude
// Code's identity and the sanitized system prompt, and every tool under its alias,
// its cache breakpoints written for the lifetime the request was given.
import { Result } from "effect"
import { buildBillingHeaderValue } from "./billing.ts"
import { isRecord, parseJson } from "./json.ts"
import { CLAUDE_CODE_IDENTITY, prependClaudeCodeIdentity } from "./system-prompt.ts"
import { prefixToolNames, statelessToolNameAliases, type ToolNameAliasTable, type ToolNameRejected } from "./tool-alias.ts"
import { CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_VERSION } from "./version.ts"

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:"

function isBillingBlock(value: unknown): boolean {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string" && value.text.startsWith(BILLING_HEADER_PREFIX)
  )
}

const hasUserMessage = (parsed: Record<string, unknown>): boolean =>
  Array.isArray(parsed.messages) && parsed.messages.some((message) => isRecord(message) && message.role === "user")

/** Whether the body was already rewritten: its tool names are aliases already. */
function hasRewriteMarker(parsed: Record<string, unknown>): boolean {
  if (!Array.isArray(parsed.system)) return false
  const hasIdentity = parsed.system.some((block) => isRecord(block) && block.text === CLAUDE_CODE_IDENTITY)
  if (!hasIdentity) return false
  return !hasUserMessage(parsed) || parsed.system.some(isBillingBlock)
}

/** The cache lifetimes Anthropic accepts on a breakpoint. */
export type CacheTTL = "5m" | "1h"

export const isCacheTTL = (value: unknown): value is CacheTTL => value === "5m" || value === "1h"

/** Give the block's breakpoint, when it has one, the lifetime `ttl`. */
const setBreakpointTTL = (block: unknown, ttl: CacheTTL): void => {
  if (isRecord(block) && isRecord(block.cache_control)) block.cache_control = { ...block.cache_control, ttl }
}

const eachBlock = (blocks: unknown, visit: (block: unknown) => void): void => {
  if (Array.isArray(blocks)) for (const block of blocks) visit(block)
}

/**
 * Visit every block of the request that may carry a cache breakpoint: the
 * request itself, each tool, each system block, each message block and each
 * block of a tool result's content. A tool's input is the model's and is
 * never visited.
 */
function eachBreakpointHolder(parsed: Record<string, unknown>, visit: (block: unknown) => void): void {
  visit(parsed)
  eachBlock(parsed.tools, visit)
  eachBlock(parsed.system, visit)
  eachBlock(parsed.messages, (message) => {
    if (!isRecord(message)) return
    eachBlock(message.content, (block) => {
      visit(block)
      if (isRecord(block) && block.type === "tool_result") eachBlock(block.content, visit)
    })
  })
}

/**
 * Write every cache breakpoint of the request for `ttl`. One lifetime
 * throughout keeps Anthropic's rule that longer lifetimes come before shorter
 * ones.
 */
function setCacheTTL(parsed: Record<string, unknown>, ttl: CacheTTL): void {
  eachBreakpointHolder(parsed, (block) => setBreakpointTTL(block, ttl))
}

/** Whether a breakpoint of the request names a lifetime: the provider configures one. */
function hasBreakpointTTL(parsed: Record<string, unknown>): boolean {
  let found = false
  eachBreakpointHolder(parsed, (block) => {
    if (isRecord(block) && isRecord(block.cache_control) && block.cache_control.ttl !== undefined) found = true
  })
  return found
}

/**
 * The lifetimes a request's cache breakpoints are written for: `named`, the
 * one another plugin chose for this request (the pool's, `CACHE_TTL_HEADER`),
 * on every breakpoint; else `own`, the agent's own lifetime
 * (`request.settings.cacheTTL`, an orchestration role's 5 minutes), only over
 * a lifetime the provider configures, so a body sent at the provider's default
 * stays as it came.
 */
export interface CacheLifetimes {
  readonly named?: CacheTTL | undefined
  readonly own?: CacheTTL | undefined
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names,
 * and write its cache breakpoints for the lifetimes given (`CacheLifetimes`).
 * A body that is not a JSON object goes out as it came; a tool name with no
 * alias fails the request.
 */
export function rewriteRequestBody(
  body: string,
  version: string = CLAUDE_CODE_VERSION,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
  lifetimes: CacheLifetimes = {},
): Result.Result<string, ToolNameRejected> {
  const value = parseJson(body)
  if (!isRecord(value)) return Result.succeed(body)
  const parsed = value
  const alreadyPrefixed = hasRewriteMarker(parsed)

  const billingHeader =
    hasUserMessage(parsed) && Array.isArray(parsed.messages)
      ? buildBillingHeaderValue(parsed.messages, version, CLAUDE_CODE_ENTRYPOINT)
      : null

  // Sanitize system prompt and prepend Claude Code identity
  const system = prependClaudeCodeIdentity(parsed.system).filter((block) => !isBillingBlock(block))

  // Prepend the billing header as a separate system block so the
  // final layout is: [billing header, identity, ...rest], Claude Code's own.
  // It follows the first user message, so a compaction changes it; it carries
  // no breakpoint, and Anthropic reads it as metadata and leaves it out of the
  // cache key: the request after a compaction still reads the system prompt
  // past it (measured, mods/cache/fingerprint.ts). Freezing it per session
  // would send a stamp that no longer matches the first message, for no cache gain.
  if (billingHeader) {
    system.unshift({ type: "text", text: billingHeader })
  }
  parsed.system = system
  if (lifetimes.named !== undefined) setCacheTTL(parsed, lifetimes.named)
  else if (lifetimes.own !== undefined && hasBreakpointTTL(parsed)) setCacheTTL(parsed, lifetimes.own)

  return prefixToolNames(parsed, alreadyPrefixed, aliases)
}

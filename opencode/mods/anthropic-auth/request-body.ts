// A Messages request body as Claude Code sends it: the billing stamp, Claude
// Code's identity and the sanitized system prompt, and every tool under its alias.
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

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 * A body that is not a JSON object goes out as it came; a tool name with no
 * alias fails the request.
 */
export function rewriteRequestBody(
  body: string,
  version: string = CLAUDE_CODE_VERSION,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
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
  // final layout is: [billing header, identity, ...rest]
  if (billingHeader) {
    system.unshift({ type: "text", text: billingHeader })
  }
  parsed.system = system

  return prefixToolNames(parsed, alreadyPrefixed, aliases)
}

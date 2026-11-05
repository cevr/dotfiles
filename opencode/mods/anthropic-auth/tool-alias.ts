// Tool names as Anthropic sees them: every tool OpenCode sends goes out under
// a reversible `mcp_` alias within Anthropic's 64-byte limit, and a response's
// aliases turn back into the names OpenCode knows.
import { Base64Url } from "effect/encoding"
import { Result, Schema } from "effect"
import { isRecord } from "./json.ts"
import { sha256Base64url } from "./sha256.ts"
import { isWellFormedUtf16 } from "./utf8.ts"

export const TOOL_PREFIX = "mcp_"
/** The longest tool name a response may carry, in UTF-8 bytes. */
export const MAX_JSON_TOOL_NAME_BYTES = 64

const SHORT_TOOL_ALIAS_PREFIX = `${TOOL_PREFIX}T`
const LONG_TOOL_ALIAS_PREFIX = `${TOOL_PREFIX}H`
const MAX_TOOL_ALIAS_BYTES = 64
const MAX_INLINE_TOOL_NAME_BYTES = 44
const DEFAULT_ALIAS_ENTRIES = 4096
const DEFAULT_ALIAS_BYTES = 256 * 1024
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

/** A tool name that cannot go out under an alias: the request is not sent. */
export class ToolNameRejected extends Schema.TaggedError<ToolNameRejected>()("ToolNameRejected", {
  message: Schema.String,
}) {}

const rejected = (message: string) => Result.fail(new ToolNameRejected({ message }))

export type ToolNameAliasOptions = {
  maxEntries?: number
  maxBytes?: number
}

/** Whether `options` are limits a table can keep: safe non-negative integers. */
export function validAliasLimits(options: ToolNameAliasOptions): boolean {
  const maxEntries = options.maxEntries ?? DEFAULT_ALIAS_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_ALIAS_BYTES
  return Number.isSafeInteger(maxEntries) && maxEntries >= 0 && Number.isSafeInteger(maxBytes) && maxBytes >= 0
}

/**
 * Reversible tool-name aliases bounded to Anthropic's 64-byte limit.
 *
 * Names up to 44 UTF-8 bytes are encoded inline. Longer names use a stable
 * SHA-256 alias and are retained in a bounded table because a lossless,
 * stateless 64-byte source -> 60-byte payload mapping is impossible.
 * Limits that are not safe non-negative integers keep nothing (`validAliasLimits`).
 */
export class ToolNameAliasTable {
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly longByName = new Map<string, string>()
  private readonly longByAlias = new Map<string, string>()
  private retainedBytes = 0
  private isDisposed = false

  constructor(options: ToolNameAliasOptions = {}) {
    const valid = validAliasLimits(options)
    this.maxEntries = valid ? (options.maxEntries ?? DEFAULT_ALIAS_ENTRIES) : 0
    this.maxBytes = valid ? (options.maxBytes ?? DEFAULT_ALIAS_BYTES) : 0
  }

  /** The alias `name` goes out under. */
  encode(name: string): Result.Result<string, ToolNameRejected> {
    if (this.isDisposed) return rejected("Tool-name alias table is disposed")
    if (!isWellFormedUtf16(name)) return rejected("Tool names must contain well-formed UTF-16")
    const bytes = utf8Encoder.encode(name)
    if (bytes.byteLength === 0) return rejected("Tool names must not be empty")

    if (bytes.byteLength <= MAX_INLINE_TOOL_NAME_BYTES) {
      const alias = `${SHORT_TOOL_ALIAS_PREFIX}${Base64Url.encode(bytes)}`
      if (utf8Encoder.encode(alias).byteLength > MAX_TOOL_ALIAS_BYTES) {
        return rejected("Encoded tool name exceeds Anthropic alias limit")
      }
      return Result.succeed(alias)
    }

    const existing = this.longByName.get(name)
    if (existing) return Result.succeed(existing)

    const alias = `${LONG_TOOL_ALIAS_PREFIX}${sha256Base64url(bytes)}`
    const collision = this.longByAlias.get(alias)
    if (collision !== undefined && collision !== name) return rejected("Tool-name alias collision")
    if (this.longByName.size >= this.maxEntries) return rejected("Tool-name alias entry limit exceeded")
    if (bytes.byteLength > this.maxBytes - this.retainedBytes) return rejected("Tool-name alias byte limit exceeded")

    this.longByName.set(name, alias)
    this.longByAlias.set(alias, name)
    this.retainedBytes += bytes.byteLength
    return Result.succeed(alias)
  }

  /** The name `alias` stands for, if this table made it. A disposed table knows none. */
  decode(alias: string): string | undefined {
    if (this.isDisposed) return undefined
    if (alias.startsWith(SHORT_TOOL_ALIAS_PREFIX)) {
      const encoded = alias.slice(SHORT_TOOL_ALIAS_PREFIX.length)
      if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined
      const bytes = Base64Url.decode(encoded)
      if (Result.isFailure(bytes)) return undefined
      if (bytes.success.byteLength > MAX_INLINE_TOOL_NAME_BYTES) return undefined
      if (Base64Url.encode(bytes.success) !== encoded) return undefined
      const name = decodeUtf8(bytes.success)
      if (name === undefined) return undefined
      const canonical = `${SHORT_TOOL_ALIAS_PREFIX}${Base64Url.encode(utf8Encoder.encode(name))}`
      return canonical === alias ? name : undefined
    }
    if (alias.startsWith(LONG_TOOL_ALIAS_PREFIX)) {
      return this.longByAlias.get(alias)
    }
    return undefined
  }

  get disposed(): boolean {
    return this.isDisposed
  }

  /** Whether the table holds a long name's alias (one only it can decode). */
  get hasStatefulAliases(): boolean {
    return !this.isDisposed && this.longByName.size > 0
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.longByName.clear()
    this.longByAlias.clear()
    this.retainedBytes = 0
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/** A table that keeps no long names: short names only. */
export function statelessToolNameAliases(): ToolNameAliasTable {
  return new ToolNameAliasTable({ maxEntries: 0, maxBytes: 0 })
}

/** Each element of `values` through `f`, stopping at the first failure. */
function traverse<A, B, E>(values: ReadonlyArray<A>, f: (value: A) => Result.Result<B, E>): Result.Result<Array<B>, E> {
  const out: Array<B> = []
  for (const value of values) {
    const result = f(value)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    out.push(result.success)
  }
  return Result.succeed(out)
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(
  parsed: Record<string, unknown>,
  alreadyPrefixed = false,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
): Result.Result<string, ToolNameRejected> {
  const prefix = (name: string): Result.Result<string, ToolNameRejected> =>
    alreadyPrefixed && name.startsWith(TOOL_PREFIX) ? Result.succeed(name) : aliases.encode(name)

  if (parsed.tools && Array.isArray(parsed.tools)) {
    const tools = traverse(parsed.tools, (tool: unknown) =>
      isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0
        ? Result.map(prefix(tool.name), (name) => ({ ...tool, name }))
        : Result.succeed(tool),
    )
    if (Result.isFailure(tools)) return Result.fail(tools.failure)
    parsed.tools = tools.success
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    const messages = traverse(parsed.messages, (message: unknown) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return Result.succeed(message)
      return Result.map(
        traverse(message.content, (block: unknown) =>
          isRecord(block) && block.type === "tool_use" && typeof block.name === "string" && block.name.length > 0
            ? Result.map(prefix(block.name), (name) => ({ ...block, name }))
            : Result.succeed(block),
        ),
        (content) => ({ ...message, content }),
      )
    })
    if (Result.isFailure(messages)) return Result.fail(messages.failure)
    parsed.messages = messages.success
  }

  return Result.succeed(JSON.stringify(parsed))
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string, aliases: ToolNameAliasTable = statelessToolNameAliases()): string {
  return text.replace(/"name"\s*:\s*"(mcp_[A-Za-z0-9_-]+)"/g, (match, alias: string) => {
    const name = aliases.decode(alias)
    return name === undefined ? match : `"name": ${JSON.stringify(name)}`
  })
}

// One server-sent event of a streamed Messages response, its tool names
// turned back from their aliases. Only the tool-name string tokens change;
// every other byte goes through as it came. A JSON payload that breaks a bound
// or is not JSON throws: this runs inside a Web Streams transformer, whose
// error protocol is a throw, and the response's reader sees the error.
import { MAX_JSON_NODES, MAX_JSON_OBJECT_KEYS } from "../streamparser/json-tokens.ts"
import { isRecord, parseJson } from "../json.ts"
import { MAX_JSON_TOOL_NAME_BYTES, TOOL_PREFIX, type ToolNameAliasTable } from "../tool-alias.ts"
import { isWellFormedUtf16, utf8Length } from "../utf8.ts"

type JsonPath = Array<string | number>

interface JsonReplacement {
  readonly path: JsonPath
  readonly value: string
}

const MAX_RESPONSE_JSON_DEPTH = 256

function isToolUseWithAlias(value: unknown): value is Record<string, unknown> & { name: string } {
  return isRecord(value) && value.type === "tool_use" && typeof value.name === "string" && value.name.startsWith(TOOL_PREFIX)
}

function validateResponseToolName(name: string): void {
  if (!isWellFormedUtf16(name)) throw new Error("Tool names must contain well-formed UTF-16")
  if (utf8Length(name) > MAX_JSON_TOOL_NAME_BYTES) {
    throw new Error(`JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`)
  }
}

function responseToolNameReplacements(value: unknown, aliases: ToolNameAliasTable): JsonReplacement[] {
  if (!isRecord(value)) return []

  if (value.type === "content_block_start" && isToolUseWithAlias(value.content_block)) {
    validateResponseToolName(value.content_block.name)
    const name = aliases.decode(value.content_block.name)
    return name === undefined ? [] : [{ path: ["content_block", "name"], value: name }]
  }

  if (value.type !== "message" || !Array.isArray(value.content)) return []

  const replacements: JsonReplacement[] = []
  for (let index = 0; index < value.content.length; index++) {
    const block: unknown = value.content[index]
    if (!isToolUseWithAlias(block)) continue
    validateResponseToolName(block.name)
    const name = aliases.decode(block.name)
    if (name !== undefined) replacements.push({ path: ["content", index, "name"], value: name })
  }
  return replacements
}

const pathKey = (path: JsonPath): string => JSON.stringify(path)

function rewriteJsonStringTokens(text: string, replacements: JsonReplacement[]): string {
  const wanted = new Map(replacements.map((replacement) => [pathKey(replacement.path), JSON.stringify(replacement.value)]))
  const edits = new Map<string, { start: number; end: number; value: string }>()
  let visited = 0
  let objectKeys = 0

  function skipWhitespace(offset: number): number {
    while (/\s/.test(text[offset] ?? "")) offset++
    return offset
  }

  function scanString(offset: number): number {
    let cursor = offset + 1
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '"') return cursor + 1
      if (char === "\\") cursor++
      cursor++
    }
    return text.length
  }

  function walkValue(offset: number, path: JsonPath, depth: number): number {
    visited++
    if (visited > MAX_JSON_NODES || depth > MAX_RESPONSE_JSON_DEPTH) {
      throw new Error("Anthropic response JSON exceeds traversal limits")
    }

    let cursor = skipWhitespace(offset)
    const char = text[cursor]
    if (char === '"') {
      const end = scanString(cursor)
      const key = pathKey(path)
      const replacement = wanted.get(key)
      if (replacement !== undefined) edits.set(key, { start: cursor, end, value: replacement })
      return end
    }

    if (char === "{") {
      cursor = skipWhitespace(cursor + 1)
      const seenKeys = new Set<string>()
      while (text[cursor] !== "}" && cursor < text.length) {
        const keyStart = cursor
        const keyEnd = scanString(keyStart)
        // The payload parsed whole already, so each key is a JSON string.
        const key = String(parseJson(text.slice(keyStart, keyEnd)))
        objectKeys += 1
        if (objectKeys > MAX_JSON_OBJECT_KEYS) throw new Error("Anthropic response JSON exceeds object-key limit")
        if (seenKeys.has(key)) throw new Error("Malformed Anthropic response JSON: duplicate object key")
        seenKeys.add(key)
        cursor = skipWhitespace(keyEnd)
        cursor = skipWhitespace(cursor + 1)
        cursor = walkValue(cursor, [...path, key], depth + 1)
        cursor = skipWhitespace(cursor)
        if (text[cursor] === ",") cursor = skipWhitespace(cursor + 1)
      }
      return cursor + 1
    }

    if (char === "[") {
      cursor = skipWhitespace(cursor + 1)
      let index = 0
      while (text[cursor] !== "]" && cursor < text.length) {
        cursor = walkValue(cursor, [...path, index], depth + 1)
        index++
        cursor = skipWhitespace(cursor)
        if (text[cursor] === ",") cursor = skipWhitespace(cursor + 1)
      }
      return cursor + 1
    }

    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor] ?? "")) cursor++
    return cursor
  }

  walkValue(0, [], 0)

  let output = text
  const orderedEdits = [...edits.values()].sort((left, right) => right.start - left.start)
  for (const edit of orderedEdits) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end)
  }
  return output
}

/** `text` with its tool names turned back, or none when it is not JSON. */
function rewriteResponseJson(text: string, aliases: ToolNameAliasTable): string | undefined {
  const value = parseJson(text)
  if (value === undefined) return undefined
  return rewriteJsonStringTokens(text, responseToolNameReplacements(value, aliases))
}

interface SseLine {
  readonly content: string
  readonly ending: string
}

function splitSseLines(event: string): SseLine[] {
  const lines: SseLine[] = []
  let offset = 0
  while (offset < event.length) {
    let cursor = offset
    while (cursor < event.length && event[cursor] !== "\r" && event[cursor] !== "\n") cursor += 1
    let ending = ""
    if (event[cursor] === "\r" && event[cursor + 1] === "\n") ending = "\r\n"
    else if (event[cursor] === "\r") ending = "\r"
    else if (event[cursor] === "\n") ending = "\n"
    lines.push({ content: event.slice(offset, cursor), ending })
    offset = cursor + ending.length
  }
  return lines
}

function sseDataValue(line: string): string | undefined {
  if (line === "data") return ""
  if (!line.startsWith("data:")) return undefined
  const value = line.slice("data:".length)
  return value.startsWith(" ") ? value.slice(1) : value
}

/** One whole event's bytes (through its blank line), its tool names turned back. */
export function transformSseEvent(bytes: Uint8Array, aliases: ToolNameAliasTable): Uint8Array {
  const event = new TextDecoder("utf-8", { fatal: true }).decode(bytes)

  const lines = splitSseLines(event)
  const dataIndexes: number[] = []
  const dataValues: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const value = sseDataValue(lines[index]?.content ?? "")
    if (value === undefined) continue
    dataIndexes.push(index)
    dataValues.push(value)
  }
  if (dataIndexes.length === 0) return bytes

  const payload = dataValues.join("\n")
  if (payload.trim() === "[DONE]") return bytes
  const firstPayloadCharacter = payload.trimStart()[0]
  const jsonLooking = firstPayloadCharacter === "{" || firstPayloadCharacter === "["
  if (!payload.includes(TOOL_PREFIX) && !jsonLooking) return bytes

  const rewritten = rewriteResponseJson(payload, aliases)
  if (rewritten === undefined) {
    if (jsonLooking) throw new Error("Malformed or truncated Anthropic response JSON")
    return bytes
  }
  if (rewritten === payload) return bytes
  const canonical = /[\r\n]/.test(rewritten) || dataIndexes.length > 1 ? JSON.stringify(parseJson(rewritten)) : rewritten
  const firstIndex = dataIndexes[0]
  const dataIndexSet = new Set(dataIndexes)
  const output = lines
    .map((line, index) => {
      if (index === firstIndex) return `data: ${canonical}${line.ending}`
      if (dataIndexSet.has(index)) return ""
      return `${line.content}${line.ending}`
    })
    .join("")
  return new TextEncoder().encode(output)
}

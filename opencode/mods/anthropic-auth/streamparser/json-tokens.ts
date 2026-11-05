// The pieces the bounded JSON response stream (`json-stream.ts`) is made of:
// its limits, frames, byte queue and token measures. They report a broken
// stream by throwing, the error protocol of a Web Streams transformer.
import { TokenType } from '@streamparser/json'
import { isWellFormedUtf16 } from '../utf8.ts'

export const MAX_JSON_TOOL_NAME_BYTES = 64
export const MAX_JSON_STRING_BYTES = 8 * 1024 * 1024
export const MAX_JSON_NUMBER_BYTES = 128
export const MAX_JSON_DEPTH = 256
export const MAX_JSON_OBJECT_KEYS = 100_000
export const MAX_JSON_RETAINED_KEY_BYTES = 8 * 1024 * 1024
export const MAX_JSON_NODES = 100_000
export const MAX_JSON_PENDING_BLOCK_BYTES = 8 * 1024 * 1024

export const TOKENIZER_SLICE_BYTES = 1024
export const encoder = new TextEncoder()

export type ObjectState = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
export type ArrayState = 'value-or-end' | 'value' | 'comma-or-end'
export type FrameRole =
  | 'root'
  | 'content-array'
  | 'message-block'
  | 'content-block'
  | 'other'

export type ObjectFrame = {
  mode: 'object'
  state: ObjectState
  role: FrameRole
  key?: string
  typeSeen: boolean
  objectType?: string
  seenType: boolean
  seenName: boolean
  seenContent: boolean
  seenContentBlock: boolean
  seenKeys: Set<string>
  retainedKeyBytes: number
}

export type ArrayFrame = {
  mode: 'array'
  state: ArrayState
  role: FrameRole
}

export type Frame = ObjectFrame | ArrayFrame

export type PendingToken = {
  offset: number
  token: TokenType
  replacement?: Uint8Array
}

export type DeferredName = {
  readonly frame: ObjectFrame
  readonly root: ObjectFrame
  readonly offset: number
  readonly tokenLength: number
  readonly name: string
}

export class ByteQueue {
  private chunks: Array<{
    readonly start: number
    readonly bytes: Uint8Array
  }> = []
  private head = 0
  private offset = 0
  private length = 0

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.chunks.push({
      start: this.offset + this.length,
      bytes: bytes.slice(),
    })
    this.length += bytes.byteLength
  }

  get start(): number {
    return this.offset
  }

  get size(): number {
    return this.length
  }

  takeTo(end: number): Uint8Array {
    const count = end - this.offset
    if (count < 0 || count > this.length) throw malformedJson()
    const output = new Uint8Array(count)
    let written = 0
    while (written < count) {
      const entry = this.chunks[this.head]
      if (!entry) throw malformedJson()
      const begin = this.offset - entry.start
      const available = entry.bytes.byteLength - begin
      const consumed = Math.min(available, count - written)
      output.set(entry.bytes.subarray(begin, begin + consumed), written)
      written += consumed
      this.offset += consumed
      this.length -= consumed
      if (begin + consumed === entry.bytes.byteLength) this.head += 1
    }
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
    return output
  }

  bytesFrom(start: number): Uint8Array {
    if (start < this.offset || start > this.offset + this.length) {
      throw malformedJson()
    }
    const output = new Uint8Array(this.offset + this.length - start)
    let outputOffset = 0
    let low = this.head
    let high = this.chunks.length
    while (low < high) {
      const middle = low + ((high - low) >> 1)
      const entry = this.chunks[middle]
      if (!entry) throw malformedJson()
      if (entry.start + entry.bytes.byteLength <= start) low = middle + 1
      else high = middle
    }
    for (let index = low; index < this.chunks.length; index += 1) {
      const entry = this.chunks[index]
      if (!entry) throw malformedJson()
      const begin = Math.max(0, start - entry.start)
      output.set(entry.bytes.subarray(begin), outputOffset)
      outputOffset += entry.bytes.byteLength - begin
    }
    return output
  }
}

export function malformedJson(detail?: string): Error {
  return new Error(
    detail
      ? `Malformed Anthropic response JSON: ${detail}`
      : 'Malformed Anthropic response JSON',
  )
}

export function assertWellFormedUtf16(value: string): void {
  if (!isWellFormedUtf16(value)) {
    throw new Error('Tool names must contain well-formed UTF-16')
  }
}

export function rawTokenLength(bytes: Uint8Array, token: TokenType): number {
  if (token === TokenType.STRING) {
    let escaped = false
    for (let index = 1; index < bytes.byteLength; index += 1) {
      const byte = bytes[index]
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) return index + 1
    }
    return 0
  }
  if (
    token === TokenType.LEFT_BRACE ||
    token === TokenType.RIGHT_BRACE ||
    token === TokenType.LEFT_BRACKET ||
    token === TokenType.RIGHT_BRACKET ||
    token === TokenType.COLON ||
    token === TokenType.COMMA
  ) {
    return 1
  }
  if (token === TokenType.TRUE || token === TokenType.NULL) return 4
  if (token === TokenType.FALSE) return 5
  if (token === TokenType.NUMBER) {
    let index = 0
    while (index < bytes.byteLength) {
      const byte = bytes[index]
      if (
        byte === 0x20 ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d ||
        byte === 0x2c ||
        byte === 0x5d ||
        byte === 0x7d
      ) {
        break
      }
      index += 1
    }
    return index
  }
  return 0
}

export function objectFrame(role: FrameRole): ObjectFrame {
  return {
    mode: 'object',
    state: 'key-or-end',
    role,
    typeSeen: false,
    seenType: false,
    seenName: false,
    seenContent: false,
    seenContentBlock: false,
    seenKeys: new Set(),
    retainedKeyBytes: 0,
  }
}

export function isPrimitive(token: TokenType): boolean {
  return (
    token === TokenType.STRING ||
    token === TokenType.NUMBER ||
    token === TokenType.TRUE ||
    token === TokenType.FALSE ||
    token === TokenType.NULL
  )
}

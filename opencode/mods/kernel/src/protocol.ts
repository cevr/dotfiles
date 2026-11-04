/**
 * What the kernel host and its worker process share: the frames they send each
 * other, the limits, the end-of-output marker and the bounded output buffer.
 * Ported from gent's `cell-protocol.ts`, without Effect, so the worker loads
 * nothing but this file and the codec.
 *
 * Frames are one JSON value per line. The worker writes its frames on fd 3 and
 * reads the host's on fd 4, so stdout and stderr stay the cell's own. A
 * snapshot or a restore may be larger than one line: it goes as lines that
 * start with `+`, each a piece of its JSON, then a line with the last piece.
 *
 * @module
 */

/** Worker-to-host frames travel on this descriptor. */
export const RESPONSE_FD = 3
/** Host-to-worker frames travel on this descriptor. */
export const REQUEST_FD = 4

/** One frame, in bytes, before its newline. */
export const MAX_FRAME_BYTES = 1024 * 1024
/** A snapshot or restore frame, in bytes, all its lines together: room for 256 MiB of clones as base64. */
export const MAX_SNAPSHOT_FRAME_BYTES = 512 * 1024 * 1024
/** A host reply's value, in bytes, leaving room for its envelope. */
export const MAX_REPLY_BYTES = MAX_FRAME_BYTES - 4 * 1024
/** The source of one call, in characters. */
export const MAX_SOURCE_CHARS = 256 * 1024
/** What one call shows: console output then the last value, in characters. */
export const MAX_DISPLAY_CHARS = 64 * 1024
/** The head the display keeps when it overflows; the rest of `MAX_DISPLAY_CHARS` is its tail. */
export const MAX_DISPLAY_HEAD_CHARS = 48 * 1024
/** Host calls one cell may have in flight at once. */
export const MAX_PENDING_CALLS = 32
/** Host calls one cell may make in all. */
export const MAX_CALLS_PER_CELL = 4096

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** One tool the cell can call, as the worker lists it. */
export interface Listing {
  readonly id: string
  readonly description: string
}

/**
 * Why a binding was left out of a snapshot: it holds a function, something
 * live (a promise, a weak reference, an iterator, a module), an object of a
 * class, something else a clone cannot carry, or too much.
 */
export type OmissionReason = "function" | "live" | `instance of ${string}` | "unsupported" | "too-deep" | "too-large"

export interface SnapshotBinding {
  readonly name: string
  readonly value: Json
}

export interface Omission {
  readonly name: string
  readonly reason: OmissionReason
}

export interface Snapshot {
  readonly bindings: ReadonlyArray<SnapshotBinding>
  readonly omitted: ReadonlyArray<Omission>
}

/** Host to worker. */
export type Request =
  | {
      readonly type: "evaluate"
      readonly id: string
      /** Echoed in the end-of-output marker, so cell output cannot forge one. */
      readonly token: string
      readonly source: string
      readonly tools: ReadonlyArray<Listing>
    }
  | { readonly type: "snapshot"; readonly id: string }
  | { readonly type: "restore"; readonly id: string; readonly bindings: ReadonlyArray<SnapshotBinding> }
  | { readonly type: "reply"; readonly call: string; readonly ok: true; readonly value: Json }
  | { readonly type: "reply"; readonly call: string; readonly ok: false; readonly message: string }

/** What one evaluation left: its display, and the bindings it added or rebound. */
export interface Evaluation {
  readonly ok: boolean
  /** Console output, then the last value or the error. */
  readonly display: string
  readonly truncated: boolean
  readonly bindings: ReadonlyArray<string>
}

/** Worker to host. */
export type Response =
  | { readonly type: "ready" }
  | ({ readonly type: "evaluated"; readonly id: string } & Evaluation)
  | ({ readonly type: "snapshot"; readonly id: string } & Snapshot)
  | { readonly type: "restored"; readonly id: string; readonly names: ReadonlyArray<string> }
  | { readonly type: "call"; readonly call: string; readonly name: string; readonly input: Json }

const encoder = new TextEncoder()
const NEWLINE = 10
/** Starts a line that holds a piece of a frame, not its end. */
const CONTINUED = 43

/**
 * One frame as bytes, ending in a newline; throws past its limit. A snapshot
 * or restore over `MAX_FRAME_BYTES` goes as pieces, one line each.
 */
export const encodeFrame = (frame: Request | Response): Uint8Array => {
  const json = encoder.encode(JSON.stringify(frame))
  const limit = frame.type === "snapshot" || frame.type === "restore" ? MAX_SNAPSHOT_FRAME_BYTES : MAX_FRAME_BYTES
  if (json.byteLength > limit) throw new Error(`frame of ${json.byteLength + 1} bytes is over the limit`)
  const piece = MAX_FRAME_BYTES - 1
  const pieces = Math.max(1, Math.ceil(json.byteLength / piece))
  const bytes = new Uint8Array(json.byteLength + 2 * pieces - 1)
  let at = 0
  for (let index = 0; index < pieces; index++) {
    const last = index === pieces - 1
    if (!last) bytes[at++] = CONTINUED
    const part = json.subarray(index * piece, last ? json.byteLength : (index + 1) * piece)
    bytes.set(part, at)
    at += part.byteLength
    bytes[at++] = NEWLINE
  }
  return bytes
}

/** Splits one pipe into frames, whatever the chunk splits; a line or frame past its limit throws. */
export const makeFrameReader = () => {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  /** The current line's bytes so far, and the pieces of the frame before it. */
  let line: Uint8Array[] = []
  let lineLength = 0
  let pieces: Uint8Array[] = []
  let frameLength = 0
  const join = (parts: ReadonlyArray<Uint8Array>, length: number) => {
    if (parts.length === 1) return parts[0]!
    const out = new Uint8Array(length)
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.byteLength
    }
    return out
  }
  /** A whole line: a piece to keep, or the end of a frame. */
  const end = (frames: unknown[]) => {
    const bytes = join(line, lineLength)
    line = []
    lineLength = 0
    if (bytes.byteLength === 0) return
    const continued = bytes[0] === CONTINUED
    const piece = continued ? bytes.subarray(1) : bytes
    frameLength += piece.byteLength
    if (frameLength > MAX_SNAPSHOT_FRAME_BYTES) throw new Error("frame over the byte limit")
    pieces.push(piece)
    if (continued) return
    const frame = join(pieces, frameLength)
    pieces = []
    frameLength = 0
    frames.push(JSON.parse(decoder.decode(frame)))
  }
  return {
    push: (chunk: Uint8Array): ReadonlyArray<unknown> => {
      const frames: unknown[] = []
      let start = 0
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(NEWLINE, start)
        const stop = newline === -1 ? chunk.byteLength : newline
        lineLength += stop - start
        if (lineLength > MAX_FRAME_BYTES) throw new Error("frame over the byte limit")
        // A copy: the stream may reuse its chunk.
        if (stop > start) line.push(chunk.slice(start, stop))
        if (newline === -1) break
        end(frames)
        start = newline + 1
      }
      return frames
    },
  }
}

// ── end of output ───────────────────────────────────────────────────────────

const DELIMITER = "\u001e"
const PREFIX = "kernel-end "
const MAX_TOKEN = 128
const MAX_MARKER = DELIMITER.length * 2 + PREFIX.length + MAX_TOKEN

/** The worker writes this to its stdout after a cell, before its result frame. */
export const outputMarker = (token: string) => `${DELIMITER}${PREFIX}${token}${DELIMITER}`

/** Text in arrival order; `marker` is set on the text a well-formed marker closed. */
export interface OutputSegment {
  readonly text: string
  readonly marker?: string
}

/**
 * Splits the worker's stdout into text and markers, whatever the chunk splits.
 * Only a marker with the expected token counts; anything else stays text.
 */
export const makeOutputScanner = (expected: () => string | undefined) => {
  let pending = ""
  return {
    push: (chunk: string): ReadonlyArray<OutputSegment> => {
      let input = pending + chunk
      pending = ""
      const segments: OutputSegment[] = []
      let text = ""
      while (input.length > 0) {
        const start = input.indexOf(DELIMITER)
        if (start === -1) {
          text += input
          break
        }
        text += input.slice(0, start)
        const end = input.indexOf(DELIMITER, start + 1)
        if (end === -1) {
          if (input.length - start > MAX_MARKER) {
            text += DELIMITER
            input = input.slice(start + 1)
            continue
          }
          pending = input.slice(start)
          break
        }
        const candidate = input.slice(start + 1, end)
        const token = candidate.slice(PREFIX.length)
        if (candidate.startsWith(PREFIX) && token.length > 0 && token === expected()) {
          segments.push({ text, marker: token })
          text = ""
          input = input.slice(end + 1)
        } else {
          text += input.slice(start, end)
          input = input.slice(end)
        }
      }
      if (text.length > 0) segments.push({ text })
      return segments
    },
  }
}

// ── code-point cuts ─────────────────────────────────────────────────────────

const splitsPairAt = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** The head of `text`, at most `max` UTF-16 units, cut between code points. */
export const cutHead = (text: string, max: number): string => {
  if (text.length <= max) return text
  const end = Math.max(0, max)
  return text.slice(0, end - Number(splitsPairAt(text, end)))
}

/** The tail of `text`, at most `max` UTF-16 units, cut between code points. */
export const cutTail = (text: string, max: number): string => {
  if (text.length <= max) return text
  const start = text.length - Math.max(0, max)
  return text.slice(start + Number(splitsPairAt(text, start)))
}

/** The notice that stands for the characters a cut dropped. */
export const omittedNotice = (count: number) => `\n... [${count} characters omitted] ...\n`

/**
 * Keeps the first `headLimit` characters and the last `limit - headLimit`, so the
 * end of a long output (usually the error) survives with its beginning.
 * `separator` goes between appends once anything is written.
 */
export const makeBoundedOutput = (options: { readonly limit: number; readonly headLimit: number; readonly separator?: string }) => {
  const separator = options.separator ?? ""
  const tailLimit = Math.max(0, options.limit - options.headLimit)
  let head = ""
  let tail = ""
  let omitted = 0
  return {
    append: (text: string): void => {
      const next = (head.length > 0 || tail.length > 0 ? separator : "") + text
      // The head takes text only while nothing has passed it.
      const added = tail.length === 0 && omitted === 0 ? cutHead(next, options.headLimit - head.length) : ""
      head += added
      if (added.length === next.length) return
      tail += next.slice(added.length)
      if (tail.length > tailLimit) {
        const kept = cutTail(tail, tailLimit)
        omitted += tail.length - kept.length
        tail = kept
      }
    },
    read: (): string => (omitted === 0 ? head + tail : `${head}${omittedNotice(omitted)}${tail}`),
    truncated: () => omitted > 0,
    reset: (): void => {
      head = ""
      tail = ""
      omitted = 0
    },
  }
}

/** `text` in at most about `chars` characters: its head and tail around an omission notice. */
export const viewOf = (text: string, chars: number): string => {
  if (text.length <= chars) return text
  const head = cutHead(text, Math.ceil(chars / 2))
  const tail = cutTail(text, Math.floor(chars / 2))
  return `${head}${omittedNotice(text.length - head.length - tail.length)}${tail}`
}

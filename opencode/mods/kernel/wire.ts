// How frames and the end of a cell's output travel between the host and its
// worker. The worker program loads this
// file, so it must stay Effect-free: it imports frame.ts for types only and, at
// run time, only limits.ts, which imports nothing.
//
// Frames are one JSON value per line. The worker writes its frames on fd 3 and
// reads the host's on fd 4, so stdout and stderr stay the cell's own. A
// snapshot or a restore may be larger than one line: it goes as lines that
// start with `+`, each a piece of its JSON, then a line with the last piece.
//
// The worker's stdout carries the cell's own output; after a cell the worker
// writes a marker with the cell's token, so the host knows the output ended.
import type { Request, Response } from "./frame.ts"
import { MAX_FRAME_BYTES, MAX_SNAPSHOT_FRAME_BYTES } from "./limits.ts"

/** Worker-to-host frames travel on this descriptor. */
export const RESPONSE_FD = 3
/** Host-to-worker frames travel on this descriptor. */
export const REQUEST_FD = 4

const encoder = new TextEncoder()
const NEWLINE = 10
/** Starts a line that holds a piece of a frame, not its end. */
const CONTINUED = 43

/** A frame as bytes, or how many bytes it would take past its limit. */
export type Encoded =
  | { readonly _tag: "Encoded"; readonly bytes: Uint8Array }
  | { readonly _tag: "Oversized"; readonly size: number }

/** The words for a frame past its limit. */
export const oversized = (size: number) => `frame of ${size} bytes is over the limit`

/**
 * One frame as bytes, ending in a newline. A snapshot or restore over
 * `MAX_FRAME_BYTES` goes as pieces, one line each; past its own limit a frame
 * is `Oversized`.
 */
export const encodeFrame = (frame: Request | Response): Encoded => {
  const json = encoder.encode(JSON.stringify(frame))
  const limit = frame.type === "snapshot" || frame.type === "restore" ? MAX_SNAPSHOT_FRAME_BYTES : MAX_FRAME_BYTES
  if (json.byteLength > limit) return { _tag: "Oversized", size: json.byteLength + 1 }
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
  return { _tag: "Encoded", bytes }
}

/** The frames whole so far, as JSON text; `error` once the pipe broke the protocol, after which nothing more is read. */
export interface Read {
  readonly frames: ReadonlyArray<string>
  readonly error?: string
}

/** Splits one pipe into frames, whatever the chunk splits. A line or frame past its limit, or bytes that are not UTF-8, end it. */
export const makeFrameReader = () => {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  /** The current line's bytes so far, and the pieces of the frame before it. */
  let line: Uint8Array[] = []
  let lineLength = 0
  let pieces: Uint8Array[] = []
  let frameLength = 0
  let broken: string | undefined
  const join = (parts: ReadonlyArray<Uint8Array>, length: number) => {
    const [only] = parts
    if (parts.length === 1 && only !== undefined) return only
    const out = new Uint8Array(length)
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.byteLength
    }
    return out
  }
  const decode = (bytes: Uint8Array): string | undefined => {
    try {
      return decoder.decode(bytes)
    } catch {
      return undefined
    }
  }
  /** A whole line: a piece to keep, or the end of a frame. Returns why the pipe broke, if it did. */
  const end = (frames: string[]): string | undefined => {
    const bytes = join(line, lineLength)
    line = []
    lineLength = 0
    if (bytes.byteLength === 0) return undefined
    const continued = bytes[0] === CONTINUED
    const piece = continued ? bytes.subarray(1) : bytes
    frameLength += piece.byteLength
    if (frameLength > MAX_SNAPSHOT_FRAME_BYTES) return "frame over the byte limit"
    pieces.push(piece)
    if (continued) return undefined
    const frame = join(pieces, frameLength)
    pieces = []
    frameLength = 0
    const text = decode(frame)
    if (text === undefined) return "a frame that is not UTF-8"
    frames.push(text)
    return undefined
  }
  return {
    push: (chunk: Uint8Array): Read => {
      const frames: string[] = []
      if (broken !== undefined) return { frames, error: broken }
      let start = 0
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(NEWLINE, start)
        const stop = newline === -1 ? chunk.byteLength : newline
        lineLength += stop - start
        if (lineLength > MAX_FRAME_BYTES) broken = "frame over the byte limit"
        // A copy: the stream may reuse its chunk.
        else if (stop > start) line.push(chunk.slice(start, stop))
        if (broken === undefined && newline !== -1) broken = end(frames)
        if (broken !== undefined) return { frames, error: broken }
        if (newline === -1) break
        start = newline + 1
      }
      return { frames }
    },
  }
}

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

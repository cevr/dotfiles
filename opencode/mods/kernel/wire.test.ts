// The worker protocol's framing, as values: a frame across lines and chunks,
// the limits that end a pipe, and the end-of-output marker a cell cannot forge.
import { describe, expect, test } from "bun:test"
import type { Request } from "./frame.ts"
import { MAX_FRAME_BYTES } from "./limits.ts"
import { encodeFrame, makeFrameReader, makeOutputScanner, outputMarker } from "./wire.ts"

const bytes = (frame: Request) => {
  const encoded = encodeFrame(frame)
  expect(encoded._tag).toBe("Encoded")
  return encoded._tag === "Encoded" ? encoded.bytes : new Uint8Array()
}

describe("a frame", () => {
  test("reads back whole, whatever the chunks split", () => {
    const frame: Request = { type: "snapshot", id: "1" }
    const encoded = bytes(frame)
    const reader = makeFrameReader()
    const halves = [reader.push(encoded.subarray(0, 5)), reader.push(encoded.subarray(5))]
    expect(halves.flatMap((read) => read.frames)).toEqual([JSON.stringify(frame)])
    expect(halves.every((read) => read.error === undefined)).toBe(true)
  })

  test("over one line goes as pieces when it is a restore, and is oversized when it is not", () => {
    const value = "x".repeat(MAX_FRAME_BYTES + 10)
    const restore: Request = { type: "restore", id: "1", bindings: [{ name: "big", value }] }
    const encoded = bytes(restore)
    expect(encoded.filter((byte) => byte === 10).length).toBe(2)
    expect(makeFrameReader().push(encoded).frames).toEqual([JSON.stringify(restore)])
    expect(encodeFrame({ type: "reply", call: "1", ok: true, value })._tag).toBe("Oversized")
  })

  test("past the line limit, or not UTF-8, ends the pipe for good", () => {
    const reader = makeFrameReader()
    expect(reader.push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(32)).error).toBe("frame over the byte limit")
    expect(reader.push(new TextEncoder().encode('{"type":"ready"}\n'))).toEqual({ frames: [], error: "frame over the byte limit" })
    expect(makeFrameReader().push(new Uint8Array([0xff, 10])).error).toBe("a frame that is not UTF-8")
  })
})

describe("the output scanner", () => {
  test("ends a cell's output only at the marker with its own token, split or not", () => {
    const scanner = makeOutputScanner(() => "t1")
    const marker = outputMarker("t1")
    const forged = outputMarker("t0")
    const segments = [...scanner.push(`out ${forged} more ${marker.slice(0, 4)}`), ...scanner.push(`${marker.slice(4)}after`)]
    expect(segments.map((segment) => segment.text).join("")).toBe(`out ${forged} more after`)
    expect(segments.filter((segment) => segment.marker !== undefined)).toEqual([{ text: "", marker: "t1" }])
  })
})

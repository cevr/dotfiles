import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { dimensionsOf, parseSize, sizeHint, sizeNote, validSize } from "./size.ts"

const bytes = (...parts: ReadonlyArray<ReadonlyArray<number>>) => Uint8Array.from(parts.flat())
const text = (ascii: string) => Array.from(ascii, (c) => c.charCodeAt(0))

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]

const png = (width: number, height: number) => bytes([0x89], text("PNG"), [13, 10, 26, 10], be32(13), text("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0])

const jpeg = (width: number, height: number) =>
  bytes([0xff, 0xd8], [0xff, 0xe0], be16(16), Array.from({ length: 14 }, () => 0), [0xff, 0xc4], be16(4), [0, 0], [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 0, 0, 0])

const riff = (chunk: string, body: ReadonlyArray<number>) => bytes(text("RIFF"), le32(4 + 8 + body.length), text("WEBP"), text(chunk), le32(body.length), body)

describe("sizes", () => {
  test("parseSize reads WIDTHxHEIGHT and nothing else", () => {
    expect(parseSize("1536x1024")).toEqual(Option.some({ width: 1536, height: 1024 }))
    expect(parseSize("auto")).toEqual(Option.none())
    expect(parseSize("1536 x 1024")).toEqual(Option.none())
    expect(validSize("auto")).toBe(true)
    expect(validSize("1x0")).toBe(false)
  })

  test("sizeHint states the size and orientation for a fixed size, nothing for auto", () => {
    expect(sizeHint("1536x1024")).toBe("\n\nOutput size: exactly 1536x1024 pixels (landscape).")
    expect(sizeHint("1024x1536")).toBe("\n\nOutput size: exactly 1024x1536 pixels (portrait).")
    expect(sizeHint("1024x1024")).toBe("\n\nOutput size: exactly 1024x1024 pixels (square).")
    expect(sizeHint("auto")).toBe("")
  })

  test("sizeNote speaks only when a fixed size came back different", () => {
    expect(sizeNote("1024x1536", Option.some({ width: 1254, height: 1254 }))).toEqual(
      Option.some("Note: the subscription backend returned 1254x1254 for 1024x1536; it chooses the final size. The paid route gives an exact size."),
    )
    expect(sizeNote("1536x1024", Option.some({ width: 1536, height: 1024 }))).toEqual(Option.none())
    expect(sizeNote("auto", Option.some({ width: 1, height: 1 }))).toEqual(Option.none())
    expect(sizeNote("1536x1024", Option.none())).toEqual(Option.none())
  })
})

describe("dimensionsOf", () => {
  test("reads a PNG's IHDR", () => expect(dimensionsOf(png(1536, 1024))).toEqual(Option.some({ width: 1536, height: 1024 })))

  test("reads a JPEG's start of frame, past the segments before it (DHT included)", () =>
    expect(dimensionsOf(jpeg(800, 600))).toEqual(Option.some({ width: 800, height: 600 })))

  test("reads the three WebP forms", () => {
    expect(dimensionsOf(riff("VP8X", [0, 0, 0, 0, ...le24(1535), ...le24(1023)]))).toEqual(Option.some({ width: 1536, height: 1024 }))
    const packed = (1535 & 0x3fff) | ((1023 & 0x3fff) * 16384)
    expect(dimensionsOf(riff("VP8L", [0x2f, ...le32(packed), 0, 0, 0, 0, 0]))).toEqual(Option.some({ width: 1536, height: 1024 }))
    expect(dimensionsOf(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480), 0, 0]))).toEqual(Option.some({ width: 640, height: 480 }))
  })

  test("anything else has none", () => {
    expect(dimensionsOf(bytes(text("GIF89a"), [1, 0, 1, 0]))).toEqual(Option.none())
    expect(dimensionsOf(bytes([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0]))).toEqual(Option.none())
  })
})

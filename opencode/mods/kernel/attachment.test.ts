// What becomes of an attached path: its type sniffed from its first bytes, and
// the line the model reads for one that was not attached.
import { describe, expect, test } from "bun:test"
import { FileTooLarge, FileUnreadable, imageOf, NotAnImage, replyOf, sniff } from "./attachment.ts"

const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : [...part])))

describe("an attached file", () => {
  test("is a PNG, JPEG, GIF or WebP by its first bytes, as Prime Agent sniffs them", () => {
    expect(sniff(bytes([0x89], "PNG\r\n\x1a\n", [0, 0]))).toBe("image/png")
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniff(bytes("GIF87a"))).toBe("image/gif")
    expect(sniff(bytes("GIF89a"))).toBe("image/gif")
    expect(sniff(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "))).toBe("image/webp")
  })

  test("with any other start is not an image: text, a RIFF that is not WebP, or too few bytes", () => {
    expect(sniff(bytes("hello"))).toBeUndefined()
    expect(sniff(bytes("RIFF", [1, 2, 3, 4], "WAVE"))).toBeUndefined()
    expect(sniff(bytes([0x89], "PN"))).toBeUndefined()
    expect(sniff(new Uint8Array())).toBeUndefined()
    expect(imageOf("/w/a.txt", bytes("hello"))).toEqual(new NotAnImage({ path: "/w/a.txt" }))
    expect(imageOf("/w/a.gif", bytes("GIF89a"))).toEqual({ path: "/w/a.gif", mime: "image/gif", bytes: bytes("GIF89a") })
  })
})

describe("the reply", () => {
  test("keeps the answer's text, adds a line for each path not attached, and carries the images in order", () => {
    const png = { path: "/w/a.png", mime: "image/png" as const, bytes: bytes([0x89], "PNG\r\n\x1a\n") }
    const gif = { path: "/w/b.gif", mime: "image/gif" as const, bytes: bytes("GIF89a") }
    const reply = replyOf({ ok: true, text: "attached 5 images: …" }, [
      png,
      new FileUnreadable({ path: "/w/gone.png", reason: "no such file" }),
      new FileTooLarge({ path: "/w/huge.png", bytes: 25_300_000, limit: 20_000_000 }),
      new NotAnImage({ path: "/w/notes.txt" }),
      gif,
    ])
    expect(reply).toEqual({
      ok: true,
      text: [
        "attached 5 images: …",
        "[not attached: /w/gone.png: no such file]",
        "[not attached: /w/huge.png: 25.3 MB, over the 20 MB limit]",
        "[not attached: /w/notes.txt: not a PNG, JPEG, GIF or WebP image]",
      ].join("\n"),
      images: [png, gif],
    })
  })
})

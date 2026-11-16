// What the showcase pane draws: the tally's OSC 7501 report as Rex's
// protocol reads it, a PNG in Kitty graphics chunks sized to the pane, a
// Markdown page as styled lines, and a frame that holds them.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { Base64 } from "effect/encoding"
import { Content, frame } from "./frame.ts"
import { Picture } from "./spool.ts"
import { drawPng, pngSize } from "./graphics.ts"
import { render, visibleWidth } from "./markdown.ts"
import { oneLine, report } from "./status.ts"

const ESC = "\u001b"

/** A PNG's first 24 bytes: the signature and an IHDR chunk of `width` × `height`, then `extra` bytes of body. */
const png = (width: number, height: number, extra = 0) => {
  const bytes = new Uint8Array(24 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const decoded = (value: string) => Result.getOrElse(Base64.decodeString(value), () => "(not base64)")

describe("the tally's status report", () => {
  test("is one OSC 7501 report: state, id, app, progress, and the line in base64", () => {
    const sent = report({ msg: "2 of 5 done", state: "working", progress: 40 })
    expect(sent.startsWith(`${ESC}]7501;`)).toBe(true)
    expect(sent.endsWith(`${ESC}\\`)).toBe(true)
    const pairs = Object.fromEntries(sent.slice(7, -2).split(":").map((pair) => { const [key = "", value = ""] = pair.split("=", 2); return [key, value] satisfies [string, string] }))
    expect(pairs).toMatchObject({ state: "working", id: "tally", app: "rex-show", progress: "40" })
    expect(decoded(sent.slice(7, -2).split(":msg=")[1])).toBe("2 of 5 done")
  })

  test("leaves progress out when there is none, and its line holds no control character", () => {
    const sent = report({ msg: "done\nnext", state: "done" })
    expect(sent).not.toContain("progress=")
    expect(oneLine("a\tb\u0007c")).toBe("a b c")
    expect(new TextEncoder().encode(oneLine("é".repeat(5000))).length).toBeLessThanOrEqual(2048)
  })
})

describe("a picture in Kitty graphics", () => {
  test("reads a PNG's size and refuses anything else", () => {
    expect(pngSize(png(600, 300))).toEqual(Option.some({ width: 600, height: 300 }))
    expect(pngSize(new TextEncoder().encode("GIF89a not a png at all"))).toEqual(Option.none())
  })

  test("sends the bytes in chunks of at most 4096 characters, placed once, the last chunk ending the transfer", () => {
    const bytes = png(10, 10, 9000)
    const sent = drawPng(bytes, { cols: 10, rows: 5 })
    const chunks = sent.split(`${ESC}\\`).filter((chunk) => chunk !== "")
    expect(chunks.length).toBe(Math.ceil(Base64.encode(bytes).length / 4096))
    expect(chunks[0]).toStartWith(`${ESC}_Ga=T,f=100,q=2,c=10,r=5,m=1;`)
    expect(chunks.at(-1)).toStartWith(`${ESC}_Gm=0;`)
    expect(chunks.map((chunk) => chunk.split(";")[1]).join("")).toBe(Base64.encode(bytes))
  })
})

describe("a Markdown page", () => {
  test("styles headings, lists, quotes and inline marks, and wraps to the width", () => {
    const lines = render("# Title\n\nSome **bold** and `code` text that is long enough to wrap\n\n- one\n> quoted\n```\nraw  code\n```", 20)
    expect(lines[0]).toContain("Title")
    expect(lines.every((line) => line.includes("raw  code") || visibleWidth(line) <= 20)).toBe(true)
    expect(lines.some((line) => line.includes("• one"))).toBe(true)
    expect(lines.some((line) => line.includes("│") && line.includes("quoted"))).toBe(true)
    expect(lines.some((line) => line.includes("raw  code"))).toBe(true)
    expect(lines.join("\n")).not.toContain("**")
  })
})

describe("a frame", () => {
  test("holds the header, the tally's line and report, and the picture", () => {
    const drawn = frame(
      { seq: 2, shown: Picture.make({ file: "/x.png", name: "x.png" }), tally: { msg: "2 of 5 done", state: "working", progress: 40 } },
      Option.some(Content.Bytes({ bytes: png(10, 10) })),
      { cols: 40, rows: 20 },
    )
    expect(drawn).toContain("showcase · x.png")
    expect(drawn).toContain("◆ 2 of 5 done · 40%")
    expect(drawn).toContain(`${ESC}_Ga=T,f=100`)
    expect(drawn).toContain(`${ESC}]7501;state=working:id=tally`)
  })

  test("without a tally clears the record, and says why a file cannot be drawn", () => {
    const drawn = frame({ seq: 1, shown: Picture.make({ file: "/x.gif", name: "x.gif" }) }, Option.some(Content.Text({ text: "GIF89a" })), { cols: 40, rows: 20 })
    expect(drawn).toContain("x.gif is not a PNG")
    expect(drawn).toContain(`${ESC}]7501;state=clear:id=tally`)
  })
})

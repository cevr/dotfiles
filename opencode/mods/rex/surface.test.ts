// How each surface is drawn in the feed: the dispatch by kind (from its
// body, else its page or the flattened post), the diff side by side (every
// removed line on the left and every added line on the right, in order, as a
// property over seeded patches), code numbered, json as a tree, lines cut to
// the width with their styles kept, and what a post hands to leaf.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { visibleWidth } from "./markdown.ts"
import { Block, clip, codeLines, diffLines, diffRows, jsonText, leafArgs, leafFile, leafHand, linesOf, Render, renderOf, textBlock } from "./surface.ts"

const BASE = "http://localhost:8228"
const STYLE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g")
const plain = (text: string) => text.replace(STYLE, "")

/** A seeded draw in [0, 1), so a failing case names its seed. */
const drawsOf = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}
const between = (draw: () => number, low: number, high: number) => low + Math.floor(draw() * (high - low + 1))

describe("a surface's render", () => {
  test("goes by its kind and body: image, Markdown, Mermaid, diff, code, terminal and json from what the list sent", () => {
    expect(renderOf({ kind: "image", index: 0, assetId: "a1" }, "p", 2, BASE)).toEqual(Render.Asset({ id: "a1", url: `${BASE}/a/a1` }))
    expect(renderOf({ kind: "markdown", index: 0, markdown: "# hi" }, "p", 2, BASE)).toEqual(Render.Markdown({ text: "# hi" }))
    expect(renderOf({ kind: "mermaid", index: 0, mermaid: "graph TD; A-->B" }, "p", 2, BASE)).toEqual(Render.Diagram({ source: "graph TD; A-->B" }))
    expect(renderOf({ kind: "diff", index: 0, patch: "@@ -1 +1 @@" }, "p", 2, BASE)).toEqual(Render.Diff({ patch: "@@ -1 +1 @@" }))
    expect(renderOf({ kind: "code", index: 0, code: "x = 1", language: "py" }, "p", 2, BASE)).toEqual(Render.Code({ code: "x = 1", language: "py" }))
    expect(renderOf({ kind: "code", index: 0, code: "x" }, "p", 2, BASE)).toEqual(Render.Code({ code: "x", language: "" }))
    expect(renderOf({ kind: "terminal", index: 0, text: "$ ls" }, "p", 2, BASE)).toEqual(Render.Terminal({ text: "$ ls" }))
    expect(renderOf({ kind: "json", index: 0, data: { a: [1] } }, "p", 2, BASE)).toEqual(Render.Json({ data: { a: [1] } }))
  })

  test("is a shot of the page at its version for html (whose body the list leaves out) or a page kind without its body; anything else is flattened", () => {
    expect(renderOf({ kind: "html", index: 1 }, "p", 3, BASE)).toEqual(Render.Shoot({ url: `${BASE}/p/p?surface=1&ver=3` }))
    expect(renderOf({ kind: "mermaid", index: 0 }, "p", 1, BASE)).toEqual(Render.Shoot({ url: `${BASE}/p/p?surface=0&ver=1` }))
    expect(renderOf({ kind: "trace", index: 0 }, "p", 1, BASE)).toEqual(Render.Flatten({ post: "p" }))
    expect(renderOf({ kind: "json", index: 0 }, "p", 1, BASE)).toEqual(Render.Flatten({ post: "p" }))
  })

  test("is text without asking anyone only for the text kinds", () => {
    expect(textBlock(Render.Markdown({ text: "a" }))._tag).toBe("Some")
    for (const render of [Render.Asset({ id: "a", url: "u" }), Render.Diagram({ source: "s" }), Render.Shoot({ url: "u" }), Render.Flatten({ post: "p" })]) {
      expect(textBlock(render)._tag).toBe("None")
    }
  })
})

describe("a diff", () => {
  const PATCH = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,4 +1,4 @@", " keep", "-old one", "-old two", "+new one", " end", ""].join("\n")

  test("pairs removed lines beside added ones, context on both sides, numbered from the hunk", () => {
    const lines = diffLines(PATCH, 100).map(plain)
    expect(lines[0]).toBe("diff --git a/x.ts b/x.ts")
    expect(lines[3]).toBe("@@ -1,4 +1,4 @@")
    expect(lines[5]).toBe(`${"   2 old one".padEnd(49)}│${"   2 new one".padEnd(49)}`)
    expect(lines[6]).toBe(`${"   3 old two".padEnd(49)}│${"".padEnd(49)}`)
    expect(lines.length).toBe(8)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100)
  })

  test("in a narrow view, is one column, removed above added", () => {
    expect(diffLines(PATCH, 40).map(plain).slice(4, 8)).toEqual([" keep", "-old one", "-old two", "+new one"])
  })

  test("keeps every removed line on the left and every added line on the right, in order, for any patch", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const draw = drawsOf(seed)
      const body = Array.from({ length: between(draw, 1, 30) }, (_, at) => `${[" ", "-", "+"][between(draw, 0, 2)]}line ${at}`)
      const rows = diffRows(["@@ -1 +1 @@", ...body].join("\n"))
      const changed = rows.flatMap((row) => Option.toArray(Option.filter(Option.liftPredicate(row, (each) => each._tag === "Pair"), (pair) => pair._tag === "Pair" && pair.change)))
      const side = (sign: string, text: (row: (typeof changed)[number]) => string) =>
        changed.flatMap((row) => Option.toArray(Option.map(Option.liftPredicate(text(row), (said) => said !== ""), (said) => `${sign}${said}`)))
      const left = side("-", (row) => (row._tag === "Pair" && row.left.text) || "")
      const right = side("+", (row) => (row._tag === "Pair" && row.right.text) || "")
      expect({ seed, left }).toEqual({ seed, left: body.filter((line) => line.startsWith("-")) })
      expect({ seed, right }).toEqual({ seed, right: body.filter((line) => line.startsWith("+")) })
    }
  })
})

describe("text in the view", () => {
  test("is cut to the width, its styles kept and reset after a cut, for any styled line", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const draw = drawsOf(seed)
      const line = Array.from({ length: between(draw, 0, 40) }, () => [`\u001b[3${between(draw, 0, 7)}m`, "ab", "c", "é", "\u001b[0m"][between(draw, 0, 4)]).join("")
      const width = between(draw, 1, 30)
      const cut = clip(line, width)
      expect({ seed, fits: visibleWidth(cut) <= width }).toEqual({ seed, fits: true })
      expect({ seed, prefix: plain(line).startsWith(plain(cut)) }).toEqual({ seed, prefix: true })
    }
  })

  test("code is numbered and coloured; json is an indented tree; a failure is its red line", () => {
    expect(codeLines("const x = 1\n// done\n", "ts", 80).map(plain)).toEqual(["1 │ const x = 1", "2 │ // done"])
    expect(jsonText(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))('{"name":"feed","posts":[1,true,null],"empty":{}}')).map(plain)).toEqual(['{', '  "name": "feed",', '  "posts": [', "    1,", "    true,", "    null", "  ],", '  "empty": {}', "}"])
    expect(linesOf(Block.Failed({ reason: "no page" }), 80).map(plain)).toEqual(["✗ no page"])
    expect(linesOf(Block.Picture({ bytes: new Uint8Array() }), 80)).toEqual([])
  })
})

describe("what a post hands to leaf", () => {
  test("its first Markdown or diff, in a file named after it, opened as leaf FILE or leaf diff --patch FILE", () => {
    const handed = leafHand([{ kind: "image", index: 0, assetId: "a" }, { kind: "diff", index: 1, patch: "@@" }, { kind: "markdown", index: 2, markdown: "# x" }])
    expect(handed).toEqual(Option.some({ diff: true, text: "@@" }))
    expect(leafHand([{ kind: "html", index: 0 }])._tag).toBe("None")
    expect(leafFile("Plan: phase 2!", { diff: false, text: "" })).toBe("Plan-phase-2-.md")
    expect(leafFile("", { diff: true, text: "" })).toBe("post.diff")
    expect(leafArgs("/bin/leaf", { diff: true, text: "" }, "/t/x.diff")).toEqual(["/bin/leaf", "diff", "--patch", "/t/x.diff"])
    expect(leafArgs("/bin/leaf", { diff: false, text: "" }, "/t/x.md")).toEqual(["/bin/leaf", "/t/x.md"])
  })
})

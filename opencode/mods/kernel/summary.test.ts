// A tool's first sentence, and the docs search over the tools.
import { describe, expect, test } from "bun:test"
import { firstSentence, search, SUMMARY_CHARS } from "./summary.ts"

describe("firstSentence", () => {
  test("is the first paragraph's first sentence on one line; an abbreviation does not end it", () => {
    expect(firstSentence("  Read a file\nfrom disk. Then more.\n\nAnother paragraph.")).toBe("Read a file from disk.")
    expect(firstSentence("Fetch a page, e.g. a doc. Then more.")).toBe("Fetch a page, e.g. a doc.")
    expect(firstSentence("No full stop")).toBe("No full stop")
    expect(firstSentence("")).toBe("")
  })

  test("cuts a long sentence at SUMMARY_CHARS with an ellipsis", () => {
    const cut = firstSentence(`${"word ".repeat(100)}.`)
    expect(cut.length).toBe(SUMMARY_CHARS)
    expect(cut.endsWith("…")).toBe(true)
  })
})

describe("search", () => {
  const tools = [
    { id: "read", description: "Read a file from the local filesystem." },
    { id: "grep", description: "Search file contents. Files are matched by pattern." },
    { id: "browse_snapshot", description: "Take a snapshot of the page." },
    { id: "websearch", description: "Search the web." },
  ]

  test("ranks a name match over a mention, best first, with each tool's first sentence", () => {
    expect(search(tools, "snapshot")).toEqual([{ name: "browse_snapshot", summary: "Take a snapshot of the page.", score: 11 }])
    expect(search(tools, "file").map((hit) => hit.name)).toEqual(["grep", "read"])
    expect(search(tools, "search").map((hit) => hit.name)).toEqual(["websearch", "grep"])
  })

  test("leaves out what does not match, and honours the limit; an empty query finds nothing", () => {
    expect(search(tools, "zebra")).toEqual([])
    expect(search(tools, "the", 1)).toHaveLength(1)
    expect(search(tools, "  ")).toEqual([])
  })
})

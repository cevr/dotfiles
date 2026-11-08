// A tool's first sentence, and the docs search over the tools.
import { describe, expect, test } from "bun:test"
import { firstSentence, search, searcher, SUMMARY_CHARS } from "./summary.ts"

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

  test("ranks by BM25 with a name's terms above the description's, best first, with each tool's first sentence", () => {
    const [hit] = search(tools, "snapshot")
    expect(hit).toMatchObject({ name: "browse_snapshot", summary: "Take a snapshot of the page." })
    expect(hit!.score).toBeGreaterThan(0)
    // "files" and "file" meet; grep's name holds neither, so it ranks by its words alone.
    expect(search(tools, "files").map((hit) => hit.name)).toEqual(["grep", "read"])
    // Only the descriptions hold "search" (websearch is one word); the shorter one ranks first.
    expect(search(tools, "search").map((hit) => hit.name)).toEqual(["websearch", "grep"])
    expect(search(tools, "read file")[0]?.name).toBe("read")
  })

  test("puts a tool whose exact name is the query first", () => {
    const named = [
      { id: "shell", description: "Run a command." },
      { id: "shell_list", description: "List each shell, every shell this shell session started." },
    ]
    expect(search(named, "Shell").map((hit) => hit.name)).toEqual(["shell", "shell_list"])
  })

  test("leaves out what does not match, and honours the limit; an empty query finds nothing", () => {
    expect(search(tools, "zebra")).toEqual([])
    expect(search(tools, "the", 1)).toHaveLength(1)
    expect(search(tools, "  ")).toEqual([])
  })

  test("asked again of one searcher, answers the same from the index it built once", () => {
    const find = searcher(tools)
    expect(find("page snapshot")).toEqual(find("page snapshot"))
    expect(find("page snapshot")).toEqual(search(tools, "page snapshot"))
  })
})

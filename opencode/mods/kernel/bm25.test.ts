// BM25 over a toy corpus: the terms, the ranking, idf, length normalisation,
// field weights and the queries that reach nothing.
import { describe, expect, test } from "bun:test"
import { DEFAULTS, index, stem, tokenize, type Document } from "./bm25.ts"

const doc = (id: string, text: string, name = ""): Document<string> => ({
  id,
  fields: [
    ...(name === "" ? [] : [{ text: name, weight: 3 }]),
    { text, weight: 1 },
  ],
})

describe("the terms", () => {
  test("split on non-word characters and at camel, snake and kebab joins, lowercased", () => {
    expect(tokenize("readFile browse_snapshot mcp-search HTTPServer, v2!")).toEqual(["read", "file", "browse", "snapshot", "mcp", "search", "http", "server", "v2"])
  })

  test("are lightly stemmed, so plural and verb forms meet", () => {
    expect(["shells", "running", "matches", "queries", "edited", "classes", "runs", "glass"].map(stem)).toEqual([
      "shell",
      "run",
      "match",
      "query",
      "edit",
      "class",
      "run",
      "glass",
    ])
    expect(stem("is")).toBe("is")
  })
})

describe("the ranking", () => {
  const corpus = [
    doc("a", "the shell runs a command in the shell"),
    doc("b", "the file reader reads a file"),
    doc("c", "the web search finds pages on the web"),
    doc("d", "the shell"),
  ]
  const ranked = index(corpus)

  test("ranks the documents a query reaches, best first; a stemmed form finds the same", () => {
    expect(ranked.search("shell").map((hit) => hit.id)).toEqual(["d", "a"])
    expect(ranked.search("shells running").map((hit) => hit.id)).toEqual(["a", "d"])
    expect(ranked.search("web pages")[0]?.id).toBe("c")
  })

  test("gives a rare term a higher idf than a common one; a term in every document still counts a little", () => {
    expect(ranked.idf("search")).toBeGreaterThan(ranked.idf("shell"))
    expect(ranked.idf("the")).toBeGreaterThan(0)
    expect(ranked.idf("the")).toBeLessThan(ranked.idf("shell"))
    expect(ranked.idf("absent")).toBe(Math.log(1 + (4 + 0.5) / 0.5))
  })

  test("normalises by length: one mention in a short document beats one in a long one, and b 0 turns that off", () => {
    const pair = [doc("long", "a note about many things and also tools and more words to pad it out"), doc("short", "a note")]
    expect(index(pair).search("note").map((hit) => hit.id)).toEqual(["short", "long"])
    const flat = index(pair, { ...DEFAULTS, b: 0 }).search("note")
    expect(flat[0]?.score).toBeCloseTo(flat[1]!.score, 10)
  })

  test("weighs a field's terms by its weight", () => {
    const fielded = index([doc("described", "snapshot of the page"), doc("named", "takes a picture of the page", "snapshot")])
    expect(fielded.search("snapshot").map((hit) => hit.id)).toEqual(["named", "described"])
  })

  test("finds nothing for an empty query or terms no document holds, and honours the limit", () => {
    expect(ranked.search("")).toEqual([])
    expect(ranked.search("  !! ")).toEqual([])
    expect(ranked.search("zebra")).toEqual([])
    expect(ranked.search("the", 2)).toHaveLength(2)
    expect(index([]).search("shell")).toEqual([])
  })

  test("gives the same answer to a query asked twice", () => {
    expect(ranked.search("shell command")).toEqual(ranked.search("shell command"))
  })
})

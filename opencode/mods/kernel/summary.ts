// A tool's words, shortened and searched: the first sentence the kernel's
// catalog shows for each tool, and the ranking `tools.docs.search(query)`
// gives in a cell. Plain functions that import only ./bm25.ts, so the worker
// loads them without Effect.
import { index } from "./bm25.ts"

/** The most characters a one-line summary keeps. */
export const SUMMARY_CHARS = 200

/**
 * The first sentence of `text`, on one line: its first paragraph up to the
 * first `.`, `!` or `?` that ends it or is followed by a capital (so "e.g."
 * goes on), at most SUMMARY_CHARS characters.
 */
export const firstSentence = (text: string): string => {
  const paragraph = (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim()
  const match = /^(.*?[.!?])(?=\s+[A-Z`"'([]|$)/.exec(paragraph)
  const sentence = match?.[1] ?? paragraph
  return sentence.length <= SUMMARY_CHARS ? sentence : `${sentence.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
}

/** One tool as docs search reads it. */
export interface Documented {
  readonly id: string
  readonly description: string
}

/** One search hit: the tool, its first sentence and its score. */
export interface Hit {
  readonly name: string
  readonly summary: string
  readonly score: number
}

/** How much a term of a tool's name counts against one of its description (BM25F field weights). */
export const NAME_WEIGHT = 3

/** A search over one set of tools: `query` to its hits, best first, at most `limit`. */
export type Searcher = (query: string, limit?: number) => ReadonlyArray<Hit>

/**
 * The docs search over `tools`, its BM25 index built once (./bm25.ts, k1 1.2,
 * b 0.75): a tool's name terms weigh NAME_WEIGHT, its description's 1. A
 * query that is a tool's exact name (any case) puts that tool first; a tool
 * no query term reaches is left out; a tie goes by name.
 */
export const searcher = (tools: ReadonlyArray<Documented>): Searcher => {
  const sorted = [...tools].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const summaries = new Map(sorted.map((tool) => [tool.id, firstSentence(tool.description)]))
  const byName = new Map(sorted.map((tool) => [tool.id.toLowerCase(), tool.id]))
  const ranked = index(
    sorted.map((tool) => ({
      id: tool.id,
      fields: [
        { text: tool.id, weight: NAME_WEIGHT },
        { text: tool.description, weight: 1 },
      ],
    })),
  )
  return (query, limit = 10) => {
    const max = Math.max(0, limit)
    const exact = byName.get(query.trim().toLowerCase())
    const scored = ranked.search(query, max + 1)
    const hits = exact === undefined ? scored : [{ id: exact, score: scored.find((hit) => hit.id === exact)?.score ?? 0 }, ...scored.filter((hit) => hit.id !== exact)]
    return hits.slice(0, max).map((hit) => ({ name: hit.id, summary: summaries.get(hit.id) ?? "", score: hit.score }))
  }
}

/** The tools that match `query`, as `searcher` ranks them; build a searcher to search one set often. */
export const search = (tools: ReadonlyArray<Documented>, query: string, limit = 10): ReadonlyArray<Hit> => searcher(tools)(query, limit)

// A tool's words, shortened and searched: the first sentence the kernel's
// catalog shows for each tool, and the ranking `tools.docs.search(query)`
// gives in a cell. Plain functions with no imports, so the worker loads them
// without Effect.

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

const words = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "")

/**
 * The tools that match `query`, best first, at most `limit`: each word of the
 * query scores 10 when it is the tool's name or one of its name's words, 4
 * when the name holds it, and 1 for each word of the description that starts
 * with it (at most 5). A tool that scores nothing is left out; a tie goes by
 * name.
 */
export const search = (tools: ReadonlyArray<Documented>, query: string, limit = 10): ReadonlyArray<Hit> => {
  const terms = words(query)
  if (terms.length === 0) return []
  return tools
    .map((tool): Hit => {
      const name = tool.id.toLowerCase()
      const nameWords = words(tool.id)
      const described = words(tool.description)
      const score = terms.reduce((total, term) => {
        const named = name === term || nameWords.includes(term) ? 10 : name.includes(term) ? 4 : 0
        const mentioned = Math.min(5, described.filter((word) => word.startsWith(term)).length)
        return total + named + mentioned
      }, 0)
      return { name: tool.id, summary: firstSentence(tool.description), score }
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, Math.max(0, limit))
}

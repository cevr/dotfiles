// BM25 ranking over small corpora held in memory, BM25F-style: each document
// is a few weighted fields (a tool's name above its description), and a term's
// frequency in a document is its count in each field times the field's
// weight. The index is built once; a search is a walk over the query terms'
// postings into one score array. Plain functions with no imports, so the
// kernel's worker loads it without Effect, and any mod can reuse it.

/** BM25's term-frequency saturation and length normalisation. */
export interface Parameters {
  readonly k1: number
  readonly b: number
}

export const DEFAULTS: Parameters = { k1: 1.2, b: 0.75 }

/** One field of a document: its text, and how much each of its terms counts. */
export interface Field {
  readonly text: string
  readonly weight: number
}

export interface Document<Id> {
  readonly id: Id
  readonly fields: ReadonlyArray<Field>
}

export interface Scored<Id> {
  readonly id: Id
  readonly score: number
}

/**
 * A word, lightly stemmed so plural and verb forms meet: `-ies` to `-y`,
 * `-es` after s, x, z, ch or sh, `-s` (not `-ss`), `-ing` and `-ed` (a doubled
 * last consonant undoubled: running, run). Short words stay as they are.
 */
export const stem = (word: string): string => {
  const undouble = (base: string) => (/([b-df-hj-np-tv-z])\1$/.test(base) && !/(ll|ss|zz)$/.test(base) ? base.slice(0, -1) : base)
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 5 && word.endsWith("ing")) return undouble(word.slice(0, -3))
  if (word.length > 4 && word.endsWith("ed")) return undouble(word.slice(0, -2))
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

/**
 * The terms of `text`: split on every character that is not a letter or
 * digit and at camelCase humps (snake_case and kebab-case split on their
 * separators), lowercased and stemmed.
 */
export const tokenize = (text: string): Array<string> => {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  const terms: Array<string> = []
  for (const word of words) {
    if (word === "") continue
    let term = stems.get(word)
    if (term === undefined) {
      term = stem(word)
      if (stems.size >= STEMS_KEPT) stems.clear()
      stems.set(word, term)
    }
    terms.push(term)
  }
  return terms
}

/** Each word's stem, as found: a corpus repeats its words, and stemming is most of tokenizing. */
const stems = new Map<string, string>()
const STEMS_KEPT = 50_000

/** A built index: rank documents by a query, and the idf a term has in it. */
export interface Index<Id> {
  readonly size: number
  /** The documents any query term reaches, best first, at most `limit`; ties keep the corpus order. */
  readonly search: (query: string, limit?: number) => Array<Scored<Id>>
  /** A term's inverse document frequency (Robertson–Sparck Jones, floored at zero by the +1). */
  readonly idf: (term: string) => number
}

/** The BM25 index of `documents`. */
export const index = <Id>(documents: ReadonlyArray<Document<Id>>, parameters: Parameters = DEFAULTS): Index<Id> => {
  const { k1, b } = parameters
  const count = documents.length
  const lengths = new Float64Array(count)
  /** Each term's postings: the documents it is in, and its weighted frequency there. */
  const postings = new Map<string, { docs: Array<number>; tf: Array<number> }>()
  documents.forEach((document, doc) => {
    const frequencies = new Map<string, number>()
    let length = 0
    for (const field of document.fields)
      for (const term of tokenize(field.text)) {
        frequencies.set(term, (frequencies.get(term) ?? 0) + field.weight)
        length += field.weight
      }
    lengths[doc] = length
    for (const [term, tf] of frequencies) {
      let list = postings.get(term)
      if (list === undefined) postings.set(term, (list = { docs: [], tf: [] }))
      list.docs.push(doc)
      list.tf.push(tf)
    }
  })
  let total = 0
  for (const length of lengths) total += length
  const average = count === 0 || total === 0 ? 1 : total / count
  /** Each document's length factor, computed once: k1 · (1 − b + b · length / average). */
  const norms = Float64Array.from(lengths, (length) => k1 * (1 - b + (b * length) / average))
  const idfOf = (frequency: number) => Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))
  const scores = new Float64Array(count)

  return {
    size: count,
    idf: (term) => idfOf(postings.get(stem(term.toLowerCase()))?.docs.length ?? 0),
    search: (query, limit = 10) => {
      const terms = [...new Set(tokenize(query))]
      scores.fill(0)
      const touched: Array<number> = []
      for (const term of terms) {
        const list = postings.get(term)
        if (list === undefined) continue
        const weight = idfOf(list.docs.length)
        for (let at = 0; at < list.docs.length; at++) {
          const doc = list.docs[at]!
          const tf = list.tf[at]!
          if (scores[doc] === 0) touched.push(doc)
          scores[doc]! += (weight * tf * (k1 + 1)) / (tf + norms[doc]!)
        }
      }
      return touched
        .filter((doc) => scores[doc]! > 0)
        .sort((left, right) => scores[right]! - scores[left]! || left - right)
        .slice(0, Math.max(0, limit))
        .map((doc) => ({ id: documents[doc]!.id, score: scores[doc]! }))
    },
  }
}

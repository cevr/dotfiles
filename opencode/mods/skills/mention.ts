// `$<skill>` tokens in a prompt's text, as gent writes them: `$` at the start
// of the text or after whitespace, then a skill id that does not start with a
// digit, then an optional tier (`$review:global`, `$review:local`). Nothing
// inside a code span or a fenced block counts, so `$5`, `a$b`, `` `$x` `` and a
// shell snippet in a fence stay plain text. Which tokens name a skill is
// catalog.ts's call; this file only finds them.
//
// Effect-free: the TUI reads it too.
import type { Tier } from "./tier.ts"

/** The character that opens a skill token, in the composer and in sent text. */
export const TRIGGER = "$"

/** One `$<id>[:<tier>]` token, by its offsets in the text (UTF-16 code units, end exclusive). */
export interface Token {
  /** The id as written, without the trigger or the tier. */
  readonly id: string
  /** The tier the token asks for; absent when it names none. */
  readonly tier?: Tier
  readonly start: number
  readonly end: number
  /** The token as written, trigger and tier included. */
  readonly text: string
}

const ID = /^[A-Za-z_][\w.-]*/
const TIER = /^:(local|global)(?![\w-])/

/** The ranges of the text inside code: fenced blocks (``` or ~~~ lines) and inline code spans. */
export const codeRanges = (text: string): ReadonlyArray<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = []
  let offset = 0
  let fence: { readonly mark: string; readonly start: number } | undefined
  const lines = text.split("\n")
  for (const line of lines) {
    const end = offset + line.length
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (opener && opener[1]?.[0] === fence.mark[0] && (opener[1]?.length ?? 0) >= fence.mark.length && line.trim() === opener[1]) {
        ranges.push([fence.start, end])
        fence = undefined
      }
    } else if (opener?.[1]) fence = { mark: opener[1], start: offset }
    else ranges.push(...spans(line, offset))
    offset = end + 1
  }
  if (fence) ranges.push([fence.start, text.length])
  return ranges
}

/** Inline code spans in one line: a run of backticks up to the next run of the same length. An unmatched run is literal. */
const spans = (line: string, offset: number): ReadonlyArray<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = []
  const runs = [...line.matchAll(/`+/g)].map((match) => ({ at: match.index, length: match[0].length }))
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]
    if (!open) continue
    const close = runs.findIndex((run, j) => j > i && run.length === open.length)
    const closing = runs[close]
    if (close < 0 || !closing) continue
    ranges.push([offset + open.at, offset + closing.at + closing.length])
    i = close
  }
  return ranges
}

/** Every `$<id>[:<tier>]` token at a word start outside code, in order. */
export const tokens = (text: string): ReadonlyArray<Token> => {
  const code = codeRanges(text)
  const inCode = (at: number) => code.some(([start, end]) => at >= start && at < end)
  const found: Array<Token> = []
  for (let at = text.indexOf(TRIGGER); at >= 0; at = text.indexOf(TRIGGER, at + 1)) {
    const before = text[at - 1]
    if (before !== undefined && !/\s/.test(before)) continue
    if (inCode(at)) continue
    const rest = text.slice(at + 1)
    // A trailing dot or dash is the sentence's, not the id's: "load $review." names `review`.
    const id = ID.exec(rest)?.[0].replace(/[.-]+$/, "")
    if (!id) continue
    const tier = TIER.exec(rest.slice(id.length))?.[1]
    const length = 1 + id.length + (tier ? tier.length + 1 : 0)
    const token = text.slice(at, at + length)
    found.push(tier === "local" || tier === "global" ? { id, tier, start: at, end: at + length, text: token } : { id, start: at, end: at + length, text: token })
  }
  return found
}

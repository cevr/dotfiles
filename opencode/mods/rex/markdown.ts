// Markdown as styled terminal text, for the showcase pane: headings bold and
// coloured, lists with bullets, quotes with a bar, fenced code dim and
// unwrapped, and inline bold, italic, code and links; the rest of each
// paragraph is wrapped to the pane's width. No HTML; tables are left as
// written.
import { Array as Arr, Option } from "effect"

const ESC = "\u001b"
const sgr = (codes: string) => `${ESC}[${codes}m`
const RESET = sgr("0")
const BOLD = sgr("1")
const DIM = sgr("2")
const ITALIC = sgr("3")
const UNDERLINE = sgr("4")
const CYAN = sgr("36")
const MAGENTA = sgr("35")
const NO_BOLD = sgr("22")
const NO_ITALIC = sgr("23")
const NO_UNDERLINE = sgr("24")
const DEFAULT_COLOUR = sgr("39")

const STYLE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

/** The columns `text` takes, its styles aside. */
export const visibleWidth = (text: string): number => Array.from(text.replace(STYLE, "")).length

/** Inline markdown in one line of text: code spans, links, bold, then italic. */
export const inline = (text: string): string =>
  text
    .replace(/`([^`]+)`/g, `${CYAN}$1${DEFAULT_COLOUR}`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `${UNDERLINE}$1${NO_UNDERLINE} ${DIM}($2)${NO_BOLD}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${NO_BOLD}`)
    .replace(/__([^_]+)__/g, `${BOLD}$1${NO_BOLD}`)
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, `$1${ITALIC}$2${NO_ITALIC}`)
    .replace(/(^|\W)_([^_\s][^_]*)_/g, `$1${ITALIC}$2${NO_ITALIC}`)

/** `text` wrapped at spaces to `width` columns, each line after the first opened by `indent`. */
export const wrap = (text: string, width: number, indent = ""): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const words = text.split(/\s+/).filter((word) => word !== "")
  const room = Math.max(1, width)
  const line = words.reduce((current, word) => {
    if (current === "") return word
    if (visibleWidth(current) + 1 + visibleWidth(word) <= room) return `${current} ${word}`
    lines.push(current)
    return `${indent}${word}`
  }, "")
  if (line !== "" || lines.length === 0) lines.push(line)
  return lines
}

/** One kind of block line: its styled lines when `line` is of that kind. */
type Rule = (line: string, width: number) => Option.Option<ReadonlyArray<string>>

const matching = (pattern: RegExp, line: string) => Option.fromNullishOr(pattern.exec(line))

const group = (found: RegExpExecArray, at: number) => Option.getOrElse(Option.fromUndefinedOr(found[at]), () => "")

const heading: Rule = (line, width) =>
  Option.map(matching(/^(#{1,6})\s+(.*)$/, line), (found) => {
    const styled = Option.match(Option.liftPredicate(group(found, 1), (marks) => marks === "#"), {
      onNone: () => `${BOLD}${CYAN}`,
      onSome: () => `${BOLD}${UNDERLINE}${MAGENTA}`,
    })
    return wrap(inline(group(found, 2)), width).map((text) => `${styled}${text}${RESET}`)
  })

const rule: Rule = (line, width) =>
  Option.map(matching(/^\s*([-*_])(\s*\1){2,}\s*$/, line), () => [`${DIM}${"─".repeat(Math.max(1, width))}${RESET}`])

const item: Rule = (line, width) =>
  Option.map(matching(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/, line), (found) => {
    const marker = group(found, 2)
    const bullet = Option.match(Option.liftPredicate(marker, (text) => /\d/.test(text)), { onNone: () => "• ", onSome: (number) => `${number} ` })
    const indent = `${group(found, 1)}${" ".repeat(bullet.length)}`
    return wrap(`${group(found, 1)}${bullet}${inline(group(found, 3))}`, width, indent)
  })

const quote: Rule = (line, width) =>
  Option.map(matching(/^>\s?(.*)$/, line), (found) => wrap(inline(group(found, 1)), width - 2).map((text) => `${DIM}│${RESET} ${text}`))

const blank: Rule = (line) => Option.map(Option.liftPredicate(line, (text) => text.trim() === ""), () => [""])

const RULES: ReadonlyArray<Rule> = [heading, rule, item, quote, blank]

const block = (line: string, width: number): ReadonlyArray<string> =>
  Option.getOrElse(
    Arr.findFirst(RULES, (each) => each(line, width)),
    () => wrap(inline(line), width),
  )

const FENCE = /^\s*(```|~~~)/

/** `markdown` as styled lines no wider than `width`, fenced code aside. */
export const render = (markdown: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const state = { fenced: false }
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) state.fenced = !state.fenced
    else if (state.fenced) lines.push(`  ${DIM}${line}${RESET}`)
    else lines.push(...block(line, width))
  }
  return lines
}

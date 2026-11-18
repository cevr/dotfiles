// The emphasis of mods/prime/emphasis.ts drawn into the host's own Markdown
// (ui.Markdown, an opentui MarkdownRenderable), with no fork change.
//
// opentui (0.9 on) writes every paragraph, heading and table cell through
// one public inline hook, the streaming preview included: `attach` sets it
// on one renderable, after any hook the host set there, and replaces the
// spans a pill or a lead label drew. Code spans keep their pills as typed,
// and the hook runs only on blocks whose source can hold a pill or a label.
import type { MarkdownInlineHook, MarkdownInlineSpan, MarkdownRenderable, Renderable, RGBA } from "@opentui/core"
import { Option } from "effect"
import { chipText, leadLabel, previewEdits, splice, type Label, type Piece, type Pill } from "../emphasis.ts"
import type { ChipColors } from "./tone.ts"

/** How a piece looks in the theme in use, read at each draw so a theme change repaints. */
export interface Look {
  readonly chip: (pill: Pill) => ChipColors
  readonly mark: (label: Label) => RGBA
}

/** What a block's source holds when it can hold a pill (`[[`) or a lead label (`**`). */
export const FILTER: ReadonlyArray<string> = ["[[", "**"]

/** Whether a renderable is opentui's Markdown, by its shape, so a second copy of opentui's classes still matches. */
function isMarkdown(renderable: Renderable): renderable is MarkdownRenderable {
  return "inlineHook" in renderable && "rerunInlineHook" in renderable && "conceal" in renderable && "content" in renderable
}

/** The first Markdown at or under `root`, depth first. */
export function findMarkdown(root: Renderable): Option.Option<MarkdownRenderable> {
  if (isMarkdown(root)) return Option.some(root)
  for (const child of root.getChildren()) {
    const found = findMarkdown(child)
    if (Option.isSome(found)) return found
  }
  return Option.none()
}

/** A span with no link and no code: a chip or a mark is never part of either. */
function plain(base: MarkdownInlineSpan): MarkdownInlineSpan {
  const { link: _, ...rest } = base
  return { ...rest, code: false }
}

/** How `piece` draws over its first span. */
const drawer = (look: Look) => (base: MarkdownInlineSpan, piece: Piece): MarkdownInlineSpan => {
  if (piece.kind === "mark") return { ...plain(base), text: `${piece.label.mark} `, fg: look.mark(piece.label), attributes: 0 }
  const colors = look.chip(piece.pill)
  return { ...plain(base), text: chipText(piece.pill), fg: colors.fg, bg: colors.bg, attributes: colors.attributes }
}

/**
 * The spans with a pill that closes the streamed source drawn whole: while streaming, opentui holds back the
 * last `]` (it could still open a link), so `[[Done]]` at the very end draws as `[[Done]`.
 */
function closeTail(spans: ReadonlyArray<MarkdownInlineSpan>, source: string): ReadonlyArray<MarkdownInlineSpan> {
  const tail = /\[\[[^[\]\n]{1,64}\]\]$/.exec(source.trimEnd())?.[0]
  const last = spans.at(-1)
  if (tail === undefined || last === undefined || last.code) return spans
  const drawn = spans.map((span) => span.text).join("")
  if (drawn.endsWith(tail) || !drawn.endsWith(tail.slice(0, -1))) return spans
  return [...spans.slice(0, -1), { ...last, text: `${last.text}]` }]
}

/** The emphasis hook: pills in the drawn text outside code, and the block's lead label; nothing in the source view. */
export const emphasisHook = (look: Look): MarkdownInlineHook => {
  const draw = drawer(look)
  return (drawn, context) => {
    if (!context.conceal) return drawn
    const spans = closeTail(drawn, context.source)
    const label = context.tableCell ? Option.none<Label>() : leadLabel(context.source.trimStart())
    const edits = previewEdits(spans, spans.map((span) => span.code), label)
    if (edits.length === 0) return drawn
    return Array.from(splice(spans, edits, draw))
  }
}

/**
 * Hooks the emphasis into one Markdown renderable, after the hook the host
 * set there (session links), whose filter it widens. The stored text is never
 * touched: the hook only builds the spans drawn. Setting it redraws the
 * blocks already shown.
 */
export function attach(markdown: MarkdownRenderable, look: Look): void {
  const mine = emphasisHook(look)
  const prior = markdown.inlineHook
  const filter = markdown.inlineHookFilter
  markdown.inlineHookFilter = prior === undefined ? FILTER : filter === undefined ? undefined : [...filter, ...FILTER]
  markdown.inlineHook = prior === undefined ? mine : (spans, context) => mine(prior(spans, context), context)
}

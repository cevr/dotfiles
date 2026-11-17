// The emphasis of mods/prime/emphasis.ts drawn into the host's own Markdown
// (ui.Markdown, an opentui MarkdownRenderable), with no fork change: the one
// file that knows opentui's private names.
//
// opentui draws a prose block twice over. While it streams, a preview built
// from marked's tokens (`renderInlineContent`, which table cells use as well);
// then tree-sitter's chunks, which each prose block hands its `onChunks`
// callback, by default the renderable's `_linkifyMarkdownChunks` (detectLinks).
// `attach` hooks both on one renderable: the final path keeps detectLinks and
// replaces the chunks a pill or a lead label drew, by their source ranges;
// the preview path splits marked's runs at the same pills. Should either
// private name go in an opentui upgrade, that path is skipped and the text
// draws as it did; the frame tests then fail the gate (no silent loss).
//
// The way out of the private names is a public inline-chunk transform on
// MarkdownRenderable covering the preview and table cells (README, Emphasis).
import type { MarkdownRenderable, OnChunksCallback, Renderable, RGBA, TextChunk } from "@opentui/core"
import { Option, Predicate } from "effect"
import { finalEdits, labelOf, pillsIn, previewEdits, splice, chipText, type Label, type Piece, type Pill } from "../emphasis.ts"
import type { ChipColors } from "./tone.ts"

/** How a piece looks in the theme in use, read at each draw so a theme change repaints. */
export interface Look {
  readonly chip: (pill: Pill) => ChipColors
  readonly mark: (label: Label) => RGBA
}

/** Which of opentui's two paths `attach` hooked: false where its private name was gone. */
export interface Attached {
  readonly final: boolean
  readonly preview: boolean
}

/** The private names hooked, as opentui 0.8 calls them. */
export const LINKIFY = "_linkifyMarkdownChunks"
export const INLINE = "renderInlineContent"

/** A marked inline token, as far as the preview path reads one. */
interface InlineToken {
  readonly type: string
  readonly text?: string
  readonly tokens?: ReadonlyArray<InlineToken>
}

type Link = TextChunk["link"]

/** Whether a renderable is opentui's Markdown, by its shape, so a second copy of opentui's classes still matches. */
function isMarkdown(renderable: Renderable): renderable is MarkdownRenderable {
  return INLINE in renderable && "conceal" in renderable && "content" in renderable && "_blockStates" in renderable
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

/** Every renderable at or under `root`. */
function each(root: Renderable, visit: (renderable: Renderable) => void) {
  visit(root)
  for (const child of root.getChildren()) each(child, visit)
}

/** A chunk with no link: a chip or a mark is never part of a link. */
function unlinked(base: TextChunk): TextChunk {
  const { link: _, ...rest } = base
  return rest
}

/** How `piece` draws over its first run. */
const drawer = (look: Look) => (base: TextChunk, piece: Piece): TextChunk => {
  if (piece.kind === "mark") return { ...unlinked(base), text: `${piece.label.mark} `, fg: look.mark(piece.label), attributes: 0 }
  const colors = look.chip(piece.pill)
  return { ...unlinked(base), text: chipText(piece.pill), fg: colors.fg, bg: colors.bg, attributes: colors.attributes }
}

const joined = (runs: ReadonlyArray<TextChunk>) => runs.map((run) => run.text).join("")

/** The source ranges tree-sitter marked as code (`markup.raw`), where a pill stays as typed. */
const codeRanges = (highlights: ReadonlyArray<readonly [number, number, string, ...ReadonlyArray<unknown>]>) =>
  highlights.flatMap(([start, end, group]) => {
    if (group === "markup.raw" || group.startsWith("markup.raw.")) return [[start, end] as const]
    return []
  })

/** Every codespan's text in marked's tokens, at any depth. */
function codeTexts(tokens: ReadonlyArray<InlineToken>): ReadonlyArray<string> {
  return tokens.flatMap((token) => {
    if (token.type === "codespan") return [token.text ?? ""]
    return codeTexts(token.tokens ?? [])
  })
}

/** Whether a run drew a codespan: its text is one, in the `markup.raw` style. */
const isCode = (markdown: MarkdownRenderable, codes: ReadonlyArray<string>) => (run: TextChunk) => {
  if (!codes.includes(run.text)) return false
  return Option.match(Option.fromNullishOr(markdown.syntaxStyle.getStyle("markup.raw")), {
    onNone: () => true,
    onSome: (style) => Option.match(Option.fromNullishOr(style.fg), { onNone: () => true, onSome: (fg) => fg.equals(run.fg) }),
  })
}

/** The lead label of a block marked lexed: its first token a bold span naming one. */
const tokenLabel = (tokens: ReadonlyArray<InlineToken>) =>
  Option.flatMap(Option.fromNullishOr(tokens[0]), (first) => {
    if (first.type !== "strong") return Option.none<Label>()
    return labelOf(first.text ?? "")
  })

/** Whether the content holds a table row: its cells drew before `attach` and need a rebuild. */
const hasTable = (content: string) => /^\s*\|.*\|\s*$/m.test(content)

/**
 * Hooks the emphasis into one Markdown renderable, once; nothing when the
 * reader shows Markdown as source (`conceal` off). The stored text is never
 * touched: the hooks only build the chunks drawn.
 */
export function attach(markdown: MarkdownRenderable, look: Look): Attached {
  const draw = drawer(look)
  const previous = markdown[LINKIFY]
  const final = Predicate.isFunction(previous)
  if (final) {
    const hook: OnChunksCallback = (chunks, context) => {
      const linked = previous(chunks, context)
      if (!markdown.conceal) return linked
      const edits = finalEdits(chunks, {
        content: context.content,
        ranges: context.sourceRanges ?? [],
        raw: codeRanges(context.highlights),
      })
      const runs = Option.getOrElse(Option.fromNullishOr(linked), () => chunks)
      if (edits.length === 0 || !Array.isArray(runs) || joined(runs) !== joined(chunks)) return linked
      return Array.from(splice(runs, edits, draw))
    }
    markdown[LINKIFY] = hook
    each(markdown, (renderable) => {
      if ("filetype" in renderable && "onChunks" in renderable && renderable.filetype === "markdown" && renderable.onChunks === previous)
        renderable.onChunks = hook
    })
  }
  const inner = markdown[INLINE]
  const preview = Predicate.isFunction(inner)
  if (preview) {
    let depth = 0
    markdown[INLINE] = (tokens: ReadonlyArray<InlineToken>, chunks: Array<TextChunk>, link?: Link) => {
      const from = chunks.length
      depth++
      inner.call(markdown, tokens, chunks, link)
      depth--
      if (depth > 0 || !markdown.conceal) return
      const added = chunks.splice(from)
      const edits = previewEdits(added, added.map(isCode(markdown, codeTexts(tokens))), tokenLabel(tokens))
      chunks.push(...splice(added, edits, draw))
    }
  }
  if ((final || preview) && pillsIn(markdown.content).length > 0 && (hasTable(markdown.content) || markdown.streaming))
    markdown.clearCache()
  return { final, preview }
}

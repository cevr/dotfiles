// How the feed pane draws each surface of a post, in the terminal: an image
// as the picture itself, Markdown as styled text, a Mermaid diagram drawn by
// Pele and shot as a picture, a diff side by side (removed on the left, added
// on the right), code with its line numbers and colour, a terminal's text as
// it was (its own colours kept), json as a coloured tree, an html surface as
// a shot of the page Sideshow serves for it, and any other kind as the post
// flattened to Markdown by Sideshow.
import { Array as Arr, Data, Match, Option, Predicate, type Schema } from "effect"
import { render as markdown, visibleWidth } from "./markdown.ts"
import type { Surface } from "./service.ts"

const ESC = "\u001b"
const sgr = (codes: string) => `${ESC}[${codes}m`
const RESET = sgr("0")
const BOLD = sgr("1")
const DIM = sgr("2")
const RED = sgr("31")
const GREEN = sgr("32")
const YELLOW = sgr("33")
const BLUE = sgr("34")
const MAGENTA = sgr("35")
const CYAN = sgr("36")

/** How one surface is drawn. */
export type Render = Data.TaggedEnum<{
  /** An uploaded image: its bytes when a PNG, else a shot of its address. */
  Asset: { readonly id: string; readonly url: string }
  /** Markdown, as styled text. */
  Markdown: { readonly text: string }
  /** A Mermaid diagram's source, drawn by Pele and shot. */
  Diagram: { readonly source: string }
  /** A unified diff, side by side. */
  Diff: { readonly patch: string }
  /** Code, numbered and coloured. */
  Code: { readonly code: string; readonly language: string }
  /** A terminal's output, its colours kept. */
  Terminal: { readonly text: string }
  /** Json data, as a coloured tree. */
  Json: { readonly data: Schema.Json }
  /** A page Sideshow serves, shot after its scripts ran. */
  Shoot: { readonly url: string }
  /** The post flattened to Markdown by Sideshow. */
  Flatten: { readonly post: string }
}>
export const Render = Data.taggedEnum<Render>()

/** The kinds Sideshow serves as a page of their own at `/p/<post>?surface=<n>`. */
const PAGE_KINDS = new Set(["html", "mermaid", "diff", "terminal", "code", "markdown"])

/**
 * How `surface` of version `version` of post `post`, on the server at
 * `base`, is drawn: by its kind, from its body; a page kind whose body the
 * list left out (an html surface's) as a shot of its page, and anything
 * else flattened.
 */
export const renderOf = (surface: Surface, post: string, version: number, base: string): Render => {
  const page = () =>
    Option.match(Option.liftPredicate(surface.kind, (kind) => PAGE_KINDS.has(kind)), {
      onSome: () => Render.Shoot({ url: `${base}/p/${post}?surface=${surface.index}&ver=${version}` }),
      onNone: () => Render.Flatten({ post }),
    })
  const asset = Option.filter(Option.fromUndefinedOr(surface.assetId), () => surface.kind === "image")
  if (Option.isSome(asset)) return Render.Asset({ id: asset.value, url: `${base}/a/${asset.value}` })
  const found = Match.value(surface.kind).pipe(
    Match.when("markdown", () => Option.map(Option.fromUndefinedOr(surface.markdown), (text) => Render.Markdown({ text }))),
    Match.when("mermaid", () => Option.map(Option.fromUndefinedOr(surface.mermaid), (source) => Render.Diagram({ source }))),
    Match.when("diff", () => Option.map(Option.fromUndefinedOr(surface.patch), (patch) => Render.Diff({ patch }))),
    Match.when("code", () => Option.map(Option.fromUndefinedOr(surface.code), (code) => Render.Code({ code, language: Option.getOrElse(Option.fromUndefinedOr(surface.language), () => "") }))),
    Match.when("terminal", () => Option.map(Option.fromUndefinedOr(surface.text), (text) => Render.Terminal({ text }))),
    Match.when("json", () => Option.map(Option.fromUndefinedOr(surface.data), (data) => Render.Json({ data }))),
    Match.orElse(() => Option.none<Render>()),
  )
  return Option.getOrElse(found, page)
}

/** What a surface came to, ready to draw: text drawn at any width, a picture, or why it could not be had. */
export type Block = Data.TaggedEnum<{
  Markdown: { readonly text: string }
  Diff: { readonly patch: string }
  Code: { readonly code: string; readonly language: string }
  Terminal: { readonly text: string }
  Json: { readonly data: Schema.Json }
  Picture: { readonly bytes: Uint8Array }
  Failed: { readonly reason: string }
}>
export const Block = Data.taggedEnum<Block>()

/** The block a text render is, without asking anyone; none for a render that needs Sideshow, Pele or the browser. */
export const textBlock = (render: Render): Option.Option<Block> =>
  Render.$match(render, {
    Markdown: ({ text }) => Option.some(Block.Markdown({ text })),
    Diff: ({ patch }) => Option.some(Block.Diff({ patch })),
    Code: ({ code, language }) => Option.some(Block.Code({ code, language })),
    Terminal: ({ text }) => Option.some(Block.Terminal({ text })),
    Json: ({ data }) => Option.some(Block.Json({ data })),
    Asset: () => Option.none(),
    Diagram: () => Option.none(),
    Shoot: () => Option.none(),
    Flatten: () => Option.none(),
  })

const STYLE_AT = new RegExp(String.raw`^\u001b\[[0-9;]*m`)

/** `line` cut to `width` columns, its styles kept and reset after a cut. */
export const clip = (line: string, width: number): string => {
  if (visibleWidth(line) <= width) return line
  const kept: Array<string> = []
  let shown = 0
  let at = 0
  const chars = Array.from(line)
  while (at < chars.length && shown < width) {
    const style = STYLE_AT.exec(chars.slice(at).join(""))
    if (style) {
      kept.push(style[0])
      at += style[0].length
    } else {
      kept.push(chars[at])
      shown += 1
      at += 1
    }
  }
  return `${kept.join("")}${RESET}`
}

/** `line` cut or padded with spaces to exactly `width` columns. */
export const pad = (line: string, width: number): string => {
  const cut = clip(line, width)
  return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`
}

const untabbed = (line: string) => line.replace(/\t/g, "  ")

/** One side of a side-by-side row: a line number and text, or nothing. */
interface Side {
  readonly number: Option.Option<number>
  readonly text: string
}

const NO_SIDE: Side = { number: Option.none(), text: "" }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** One row of a side-by-side diff. */
type DiffRow = Data.TaggedEnum<{
  Header: { readonly text: string }
  Hunk: { readonly text: string }
  Pair: { readonly left: Side; readonly right: Side; readonly change: boolean }
}>
const DiffRow = Data.taggedEnum<DiffRow>()

/** The lines of a diff read so far: the changed lines not yet paired, and the next line's number on each side. */
interface Run {
  removed: Array<Side>
  added: Array<Side>
  old: number
  new: number
}

/** A unified diff's rows: file headers, hunk headers, and lines paired (removed beside added, context on both sides). */
export const diffRows = (patch: string): ReadonlyArray<DiffRow> => {
  const rows: Array<DiffRow> = []
  const run: Run = { removed: [], added: [], old: 0, new: 0 }
  const flush = () => {
    // Not Arr.makeBy: it makes one item for zero.
    Array.from({ length: Math.max(run.removed.length, run.added.length) }, (_, at) => at).forEach((at) => {
      rows.push(DiffRow.Pair({ left: Option.getOrElse(Arr.get(run.removed, at), () => NO_SIDE), right: Option.getOrElse(Arr.get(run.added, at), () => NO_SIDE), change: true }))
    })
    run.removed = []
    run.added = []
  }
  for (const raw of patch.split(/\r?\n/)) {
    const line = untabbed(raw)
    const hunk = HUNK.exec(line)
    if (hunk) {
      flush()
      run.old = Number(hunk[1])
      run.new = Number(hunk[2])
      rows.push(DiffRow.Hunk({ text: line }))
    } else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      flush()
      rows.push(DiffRow.Header({ text: line }))
    } else if (line.startsWith("-")) {
      run.removed.push({ number: Option.some(run.old), text: line.slice(1) })
      run.old += 1
    } else if (line.startsWith("+")) {
      run.added.push({ number: Option.some(run.new), text: line.slice(1) })
      run.new += 1
    } else if (line.startsWith("\\")) {
      flush()
      rows.push(DiffRow.Hunk({ text: line }))
    } else if (line !== "" || run.old > 0) {
      flush()
      const text = line.slice(1)
      rows.push(DiffRow.Pair({ left: { number: Option.some(run.old), text }, right: { number: Option.some(run.new), text }, change: false }))
      run.old += 1
      run.new += 1
    }
  }
  flush()
  // A patch's last newline leaves one empty context pair: drop a trailing pair with no text on either side.
  const emptyLast = Option.exists(Arr.last(rows), (last) => last._tag === "Pair" && !last.change && last.left.text === "" && last.right.text === "")
  return rows.slice(0, rows.length - Number(emptyLast))
}

/** `yes` when `test` holds, else `no`. */
const choose = <A>(test: boolean, yes: A, no: A): A => Option.getOrElse(Option.map(Option.liftPredicate(yes, () => test), (picked) => picked), () => no)

const sideText = (side: Side, colour: string, width: number) => {
  const number = Option.match(side.number, { onNone: () => "    ", onSome: (n) => String(n).padStart(4) })
  const text = Option.match(side.number, { onNone: () => "", onSome: () => `${colour}${side.text}${RESET}` })
  return pad(`${DIM}${number}${RESET} ${text}`, width)
}

/** A unified diff as lines `width` columns wide: side by side (old left, new right) when there is room, else one column, removed above added. */
export const diffLines = (patch: string, width: number): ReadonlyArray<string> => {
  const rows = diffRows(patch)
  const half = Math.floor((width - 1) / 2)
  const header = (text: string, style: string) => clip(`${style}${text}${RESET}`, width)
  if (half < 24) {
    return patch.split(/\r?\n/).map((raw) => {
      const line = untabbed(raw)
      if (line.startsWith("@@")) return header(line, CYAN)
      if (/^(diff |--- |\+\+\+ )/.test(line)) return header(line, BOLD)
      if (line.startsWith("-")) return header(line, RED)
      if (line.startsWith("+")) return header(line, GREEN)
      return clip(line, width)
    })
  }
  return rows.map((row) =>
    DiffRow.$match(row, {
      Header: ({ text }) => header(text, BOLD),
      Hunk: ({ text }) => header(text, CYAN),
      Pair: ({ left, right, change }) => `${sideText(left, choose(change, RED, ""), half)}${DIM}│${RESET}${sideText(right, choose(change, GREEN, ""), half)}`,
    }),
  )
}

const KEYWORDS = new Set(
  "abstract as async await break case catch class const continue def default defer del do elif else enum export extends false fi final fn for from func function go if impl import in interface let loop match mod module mut new nil none null package pass private protected pub public return self static struct super switch then this throw trait true try type typeof undefined use var void when where while with yield".split(" "),
)

const TOKEN = /\/\/.*$|#.*$|--.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_.]*\b|\b[A-Za-z_]\w*\b/g

/** Languages where `#` opens no comment, and those where `--` opens one. */
const HASH_IS_CODE = /^(js|ts|tsx|jsx|javascript|typescript|go|rust|swift|css|c|cpp|java|kotlin)$/
const DASHES_COMMENT = /^(sql|lua|haskell|hs|elm)$/

/** Whether `token` is a comment in `language`. */
const isComment = (token: string, language: string) =>
  token.startsWith("//") || (token.startsWith("#") && !HASH_IS_CODE.test(language)) || (token.startsWith("--") && DASHES_COMMENT.test(language))

/** One token of code coloured by what it looks like. */
const colourToken = (token: string, language: string): string => {
  if (isComment(token, language)) return `${DIM}${token}${RESET}`
  if (/^["'`]/.test(token)) return `${GREEN}${token}${RESET}`
  if (/^\d/.test(token)) return `${MAGENTA}${token}${RESET}`
  if (KEYWORDS.has(token)) return `${BLUE}${token}${RESET}`
  return token
}

/** One line of code coloured: comments dim, strings green, numbers magenta, keywords blue. A guess across languages, not a parser. */
export const colourCode = (line: string, language: string): string => line.replace(TOKEN, (token) => colourToken(token, language))

/** Code as numbered, coloured lines cut to `width` columns. */
export const codeLines = (code: string, language: string, width: number): ReadonlyArray<string> => {
  const lines = code.replace(/\n$/, "").split(/\r?\n/)
  const gutter = String(lines.length).length
  return lines.map((line, at) => clip(`${DIM}${String(at + 1).padStart(gutter)} │${RESET} ${colourCode(untabbed(line), language)}`, width))
}

/** A terminal's output as lines cut to `width` columns, its own colours kept. */
export const terminalLines = (text: string, width: number): ReadonlyArray<string> =>
  text.replace(/\n$/, "").split(/\r?\n/).map((line) => clip(untabbed(line), width))

const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

/** Json data as coloured, indented lines: keys cyan, strings green, numbers magenta, true, false and null yellow. */
export const jsonText = (data: Schema.Json, indent = ""): ReadonlyArray<string> => {
  const inner = `${indent}  `
  /** Items between `open` and `close`, each indented, a comma after all but the last. */
  const nested = (items: ReadonlyArray<ReadonlyArray<string>>, open: string, close: string): ReadonlyArray<string> =>
    choose(items.length === 0, [`${open}${close}`], [
      open,
      ...items.flatMap((lines, item) => withComma(lines, item < items.length - 1).map((line, at) => choose(at === 0, `${inner}${line}`, line))),
      `${indent}${close}`,
    ])
  if (Array.isArray(data)) return nested(data.map((item: Schema.Json) => jsonText(item, inner)), "[", "]")
  if (Predicate.isString(data)) return [`${GREEN}${quoted(data)}${RESET}`]
  if (Predicate.isNumber(data)) return [`${MAGENTA}${String(data)}${RESET}`]
  if (Predicate.isBoolean(data)) return [`${YELLOW}${String(data)}${RESET}`]
  if (Predicate.isNull(data)) return [`${YELLOW}null${RESET}`]
  return nested(
    Object.entries(data).map(([key, value]) => {
      const lines = jsonText(value, inner)
      return [`${CYAN}${quoted(key)}${RESET}: ${Option.getOrElse(Arr.head(lines), () => "")}`, ...lines.slice(1)]
    }),
    "{",
    "}",
  )
}

const withComma = (lines: ReadonlyArray<string>, comma: boolean): ReadonlyArray<string> =>
  choose(comma, [...lines.slice(0, -1), `${Option.getOrElse(Arr.last(lines), () => "")},`], lines)

/** What a post hands to leaf: its first Markdown, or its first diff, and which it is. */
export interface Handed {
  readonly diff: boolean
  readonly text: string
}

/** The first surface of `surfaces` leaf opens: Markdown it reads, a diff it reviews; none when there is neither. */
export const leafHand = (surfaces: ReadonlyArray<Surface>): Option.Option<Handed> =>
  Arr.findFirst(surfaces, (surface) =>
    Option.orElse(
      Option.map(Option.filter(Option.fromUndefinedOr(surface.markdown), () => surface.kind === "markdown"), (text) => ({ diff: false, text })),
      () => Option.map(Option.filter(Option.fromUndefinedOr(surface.patch), () => surface.kind === "diff"), (text) => ({ diff: true, text })),
    ),
  )

/** The file a post titled `title` is handed in: its title made a file name, `.md` or `.diff`. */
export const leafFile = (title: string, handed: Handed): string =>
  `${Option.getOrElse(Option.liftPredicate(title.replace(/[^\w.-]+/g, "-").slice(0, 60), (name) => name !== ""), () => "post")}.${choose(handed.diff, "diff", "md")}`

/** leaf's arguments for a handed file: `leaf diff --patch FILE` for a diff, `leaf FILE` for Markdown. */
export const leafArgs = (leaf: string, handed: Handed, file: string): ReadonlyArray<string> => choose(handed.diff, [leaf, "diff", "--patch", file], [leaf, file])

/** A text block's lines `width` columns wide; a picture has none (it is placed, not written), and a failure is its red line. */
export const linesOf = (block: Block, width: number): ReadonlyArray<string> =>
  Block.$match(block, {
    Markdown: ({ text }) => markdown(text, width).map((line) => clip(line, width)),
    Diff: ({ patch }) => diffLines(patch, width),
    Code: ({ code, language }) => codeLines(code, language, width),
    Terminal: ({ text }) => terminalLines(text, width),
    Json: ({ data }) => jsonText(data).map((line) => clip(line, width)),
    Picture: () => [],
    Failed: ({ reason }) => [clip(`${RED}✗ ${reason}${RESET}`, width)],
  })

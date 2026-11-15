// One frame of the showcase pane: the screen cleared, a header naming what
// is shown, the tally's line, then the picture or the page in the room left,
// and the tally's status report for Rex. The viewer writes a new frame each
// time the spool or the pane's size changes.
import { Data, Option } from "effect"
import { type Cells, type CellPixels, clearPictures, DEFAULT_CELL, drawPng, fit, pngSize } from "./graphics.ts"
import { render } from "./markdown.ts"
import { Shown, type Spooled } from "./spool.ts"
import { clearReport, oneLine, report, type Tally } from "./status.ts"

const ESC = "\u001b"
const CLEAR = `${ESC}[H${ESC}[2J${ESC}[3J`
const HIDE_CURSOR = `${ESC}[?25l`
const DIM = `${ESC}[2m`
const BOLD = `${ESC}[1m`
const RESET = `${ESC}[0m`

/** What the shown file holds, as the viewer read it: a picture's bytes, a page's text, or why it could not. */
export type Content = Data.TaggedEnum<{
  Bytes: { readonly bytes: Uint8Array }
  Text: { readonly text: string }
  Unreadable: { readonly reason: string }
}>
export const Content = Data.taggedEnum<Content>()

const cut = (text: string, cols: number) => Array.from(text).slice(0, Math.max(1, cols)).join("")

const tallyLine = (tally: Tally, cols: number) => {
  const progress = Option.match(Option.fromUndefinedOr(tally.progress), { onNone: () => "", onSome: (value) => ` · ${value}%` })
  return `${BOLD}${cut(`◆ ${oneLine(tally.msg)}${progress}`, cols)}${RESET}`
}

const page = (text: string, room: Cells) => render(text, room.cols).slice(0, room.rows).join("\r\n")

const picture = (name: string, bytes: Uint8Array, room: Cells, cell: CellPixels) =>
  Option.match(pngSize(bytes), {
    onNone: () => `${DIM}${cut(`${name} is not a PNG`, room.cols)}${RESET}`,
    onSome: (size) => drawPng(bytes, fit(size, room, cell)),
  })

const body = (shown: Shown, content: Content, room: Cells, cell: CellPixels): string =>
  Content.$match(content, {
    Unreadable: ({ reason }) => `${DIM}${cut(reason, room.cols)}${RESET}`,
    Text: ({ text }) => Shown.match(shown, { Page: () => page(text, room), Picture: () => picture(shown.name, new TextEncoder().encode(text), room, cell) }),
    Bytes: ({ bytes }) => Shown.match(shown, { Page: () => page(new TextDecoder().decode(bytes), room), Picture: () => picture(shown.name, bytes, room, cell) }),
  })

/** The frame for `spooled` in a pane of `size` cells of `cell` pixels, `content` being what its shown file holds. */
export const frame = (spooled: Spooled, content: Option.Option<Content>, size: Cells, cell: CellPixels = DEFAULT_CELL): string => {
  const shown = Option.fromUndefinedOr(spooled.shown)
  const tally = Option.fromUndefinedOr(spooled.tally)
  const name = Option.match(shown, { onNone: () => "showcase", onSome: (item) => `showcase · ${item.name}` })
  const header = [`${DIM}${cut(name, size.cols)}${RESET}`, ...Option.toArray(Option.map(tally, (item) => tallyLine(item, size.cols)))]
  const room = { cols: size.cols, rows: Math.max(1, size.rows - header.length - 1) }
  const drawn = Option.match(Option.all({ shown, content }), {
    onNone: () => `${DIM}Nothing shown yet: rex-show image FILE, rex-show md FILE${RESET}`,
    onSome: (both) => body(both.shown, both.content, room, cell),
  })
  const status = Option.match(tally, { onNone: () => clearReport, onSome: report })
  return `${HIDE_CURSOR}${clearPictures}${CLEAR}${header.join("\r\n")}\r\n${drawn}${status}`
}

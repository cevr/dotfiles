// A PNG drawn in a terminal with the Kitty graphics protocol, which Rex's
// terminal speaks: the file's bytes in base64, sent in chunks of 4096
// characters, placed over a number of cells that keeps the picture's shape
// and fits the pane. https://sw.kovidgoyal.net/kitty/graphics-protocol/
import { Array as Arr, Option } from "effect"
import { Base64 } from "effect/encoding"

/** A picture's size in pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** A placement's size in terminal cells. */
export interface Cells {
  readonly cols: number
  readonly rows: number
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** How much taller a terminal cell is than wide, near enough for any common font. */
const CELL_ASPECT = 2

/** The protocol's largest chunk of base64. */
const CHUNK = 4096

const ESC = "\u001b"

const uint32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at)

/** Whether `bytes` start with the PNG signature and an IHDR chunk. */
export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 24 && SIGNATURE.every((byte, at) => bytes[at] === byte) && new TextDecoder().decode(bytes.slice(12, 16)) === "IHDR"

/** A PNG's size from its IHDR chunk; none for anything else. */
export const pngSize = (bytes: Uint8Array): Option.Option<Size> =>
  Option.filter(
    Option.liftPredicate(bytes, isPng).pipe(Option.map((png) => ({ width: uint32(png, 16), height: uint32(png, 20) }))),
    (size) => size.width > 0 && size.height > 0,
  )

/** The cells a picture of `size` takes in a space of `space` cells: as wide as fits, its shape kept, never more than one cell less than the space. */
export const fit = (size: Size, space: Cells): Cells => {
  const cols = Math.max(1, space.cols)
  const rows = Math.max(1, space.rows)
  const rowsAtFullWidth = Math.max(1, Math.ceil((cols * size.height) / size.width / CELL_ASPECT))
  if (rowsAtFullWidth <= rows) return { cols, rows: rowsAtFullWidth }
  return { cols: Math.max(1, Math.min(cols, Math.floor((rows * size.width * CELL_ASPECT) / size.height))), rows }
}

/** The escape sequences that draw `png` at the cursor over `cells`, with replies off (`q=2`). */
export const drawPng = (png: Uint8Array, cells: Cells): string => {
  const data = Base64.encode(png)
  const chunks = Arr.makeBy(Math.max(1, Math.ceil(data.length / CHUNK)), (at) => data.slice(at * CHUNK, (at + 1) * CHUNK))
  const last = chunks.length - 1
  return chunks
    .map((chunk, at) => {
      const more = `m=${Number(at < last)}`
      const keys = Option.match(Option.liftPredicate(at, (index) => index === 0), {
        onNone: () => more,
        onSome: () => `a=T,f=100,q=2,c=${cells.cols},r=${cells.rows},${more}`,
      })
      return `${ESC}_G${keys};${chunk}${ESC}\\`
    })
    .join("")
}

/** The escape sequence that removes every picture from the screen, with replies off. */
export const clearPictures = `${ESC}_Ga=d,d=A,q=2${ESC}\\`

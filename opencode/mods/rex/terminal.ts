// What the showcase pane's terminal says about its cells: the viewer sends
// two XTWINOPS queries and reads the replies from its own input. CSI 16 t
// asks for one cell's size in pixels (reply `CSI 6 ; height ; width t`),
// CSI 14 t for the text area's (reply `CSI 4 ; height ; width t`), which
// divided by the pane's columns and rows gives a cell too. Rex answers both.
// A terminal that answers neither leaves the default cell (graphics.ts).
import { Option } from "effect"
import type { Cells, CellPixels } from "./graphics.ts"

const ESC = "\u001b"

/** Both queries, sent together: the cell's size, then the text area's. */
export const CELL_QUERIES = `${ESC}[16t${ESC}[14t`

/** The `height ; width` of the first reply of `kind` (6: a cell, 4: the text area) in `input`, both positive. */
const reply = (input: string, kind: number): Option.Option<CellPixels> =>
  Option.flatMap(Option.fromNullishOr(new RegExp(`\\u001b\\[${kind};(\\d+);(\\d+)t`).exec(input)), (found) =>
    Option.liftPredicate({ height: Number(found[1]), width: Number(found[2]) }, (size) => size.height > 0 && size.width > 0),
  )

/** Whether `input` holds every reply the viewer waits for: the cell's, or else the text area's. */
export const answered = (input: string): boolean => Option.isSome(reply(input, 6)) || Option.isSome(reply(input, 4))

/**
 * One cell's size in pixels from the replies in `input`: the cell reply
 * when there is one, else the text area's divided by `cells`; none when
 * the terminal sent neither.
 */
export const cellOf = (input: string, cells: Cells): Option.Option<CellPixels> =>
  Option.orElse(reply(input, 6), () =>
    Option.map(reply(input, 4), (area) => ({ width: area.width / Math.max(1, cells.cols), height: area.height / Math.max(1, cells.rows) })),
  )

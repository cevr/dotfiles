// A web page in the showcase pane: the viewer shoots it again every few
// seconds, and when the pane's size or what is shown changes; it draws a
// shot only when it differs from the one on screen (by fingerprint), so an
// unchanged page costs a shot but no redraw. The shot is as wide as asked
// and as tall as the pane's room in pixels, so it fills the pane.
import { Option } from "effect"
import type { Cells, CellPixels } from "./graphics.ts"

/** How often a page is shot again by default, in seconds. */
export const DEFAULT_EVERY = 5

/** How wide a page is shot by default, in pixels. */
export const DEFAULT_WIDTH = 1280

/** The last shot the viewer took: for which spool change and pane size, when, and its fingerprint. */
export interface Taken {
  readonly seq: number
  readonly sized: string
  readonly at: number
  readonly print: number
}

/** Whether a page is due a new shot at `now`: none taken yet, what is shown or the pane's size changed, or `everyMs` passed. */
export const due = (last: Option.Option<Taken>, seq: number, sized: string, now: number, everyMs: number): boolean =>
  Option.match(last, {
    onNone: () => true,
    onSome: (taken) => taken.seq !== seq || taken.sized !== sized || now - taken.at >= everyMs,
  })

/** A 32-bit FNV-1a fingerprint of `bytes`: two shots that print the same are taken as the same picture. */
export const fingerprint = (bytes: Uint8Array): number =>
  bytes.reduce((hash, byte) => Math.imul(hash ^ byte, 0x01000193) >>> 0, 0x811c9dc5)

/** The viewport for a shot `width` pixels wide that fills `room` cells of `cell` pixels: as tall as the room's shape. */
export const viewport = (width: number, room: Cells, cell: CellPixels) => ({
  width,
  height: Math.max(1, Math.round((width * Math.max(1, room.rows) * cell.height) / (Math.max(1, room.cols) * cell.width))),
})

/** A short name for `url` in the pane's header: its host and path, without the scheme or a trailing slash. */
export const nameOf = (url: URL): string => `${url.host}${url.pathname}`.replace(/\/$/, "") || url.href

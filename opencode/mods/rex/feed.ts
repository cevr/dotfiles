// A Sideshow session in the showcase pane, as the feed (feedview.ts draws
// it): how often the viewer asks for its posts, how wide a post's page is
// shot, how long a page's scripts may run first, and which session the
// `sideshow` CLI falls back to for a folder.
import { Array as Arr, Option, Order, Schema } from "effect"

/** How often the viewer asks Sideshow for new posts by default, in seconds. */
export const FEED_EVERY = 3

/** How wide a post's page is shot, in pixels: about the width Sideshow's viewer gives a card. */
export const FEED_WIDTH = 1000

/** How long a surface page's scripts may run before its shot (a page may draw after it loads), in ms. */
export const SETTLE_MS = 5_000

/** One session in Sideshow's list: its id, title, the folder its agent ran in (Sideshow sends null for an untitled session or one with no folder), and when it was last active. */
export const SessionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  lastActiveAt: Schema.optional(Schema.String),
})
export type SessionRow = typeof SessionRow.Type

/** The session active last of those whose agent ran in `cwd`, as the `sideshow` CLI falls back to; none when there is none. */
export const byCwd = (sessions: ReadonlyArray<SessionRow>, cwd: string): Option.Option<string> =>
  Option.map(
    Arr.head(Arr.sort(sessions.filter((row) => row.cwd === cwd), lastActiveFirst)),
    (row) => row.id,
  )

const lastActiveFirst = Order.flip(Order.mapInput(Order.String, (row: SessionRow) => Option.getOrElse(Option.fromUndefinedOr(row.lastActiveAt), () => "")))

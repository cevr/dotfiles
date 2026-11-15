// What a session's showcase pane draws: the picture, page, URL, Sideshow session or simulator shown last, and
// the tally. Each rex-show call changes one of the two and keeps the other;
// the viewer draws the whole of it again whenever it changes.
import { Option, Schema } from "effect"
import { Tally } from "./status.ts"

/** A PNG, drawn as large as the pane allows. */
export const Picture = Schema.TaggedStruct("Picture", { file: Schema.String, name: Schema.String })
export type Picture = typeof Picture.Type

/** A Markdown file, drawn as styled text. */
export const Page = Schema.TaggedStruct("Page", { file: Schema.String, name: Schema.String })
export type Page = typeof Page.Type

/** A web page, shot by a headless browser on the viewer's host every `every` seconds, `width` pixels wide and as tall as the pane's shape. */
export const Url = Schema.TaggedStruct("Url", { url: Schema.String, name: Schema.String, every: Schema.Number, width: Schema.Int })
export type Url = typeof Url.Type

/** A Sideshow session at `base`, followed by the viewer every `every` seconds: its latest post drawn, `name` until the session's title is known. */
export const Feed = Schema.TaggedStruct("Feed", { base: Schema.String, session: Schema.String, name: Schema.String, every: Schema.Number })
export type Feed = typeof Feed.Type

/**
 * A booted iOS simulator, screenshot by the viewer every `every` seconds:
 * `device` by name or udid ("" for the one used last), on the Mac `host`
 * reached with ssh ("" for this host).
 */
export const Sim = Schema.TaggedStruct("Sim", { device: Schema.String, host: Schema.String, name: Schema.String, every: Schema.Number })
export type Sim = typeof Sim.Type

export const Shown = Schema.Union([Picture, Page, Url, Feed, Sim]).pipe(Schema.toTaggedUnion("_tag"))
export type Shown = typeof Shown.Type

/** The spool of one session: a counter that grows with each change, what is shown, and the tally. */
export const Spooled = Schema.Struct({
  seq: Schema.Int,
  shown: Schema.optional(Shown),
  tally: Schema.optional(Tally),
})
export type Spooled = typeof Spooled.Type

/** A session's spool before its first call. */
export const empty: Spooled = { seq: 0 }

/** `spooled` showing `shown` instead, its tally kept. */
export const show = (spooled: Spooled, shown: Shown): Spooled => ({ ...spooled, seq: spooled.seq + 1, shown })

/** `spooled` with `tally` instead, what it shows kept. */
export const count = (spooled: Spooled, tally: Tally): Spooled => ({ ...spooled, seq: spooled.seq + 1, tally })

/** The tally of `spooled`, if one was set. */
export const tallyOf = (spooled: Spooled): Option.Option<Tally> => Option.fromUndefinedOr(spooled.tally)

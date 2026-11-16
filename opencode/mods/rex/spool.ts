// What a session's showcase pane draws: the picture, page, URL, Sideshow session, simulator or live tab shown last, and
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

/**
 * A live tab on `url` in a headless browser on the viewer's host: its
 * frames drawn at most `fps` a second, clicks, scrolls and keys sent back;
 * `width` CSS pixels wide (0: as wide as the pane's pixels).
 */
export const Browse = Schema.TaggedStruct("Browse", { url: Schema.String, name: Schema.String, width: Schema.Int, fps: Schema.Number })
export type Browse = typeof Browse.Type

export const Shown = Schema.Union([Picture, Page, Url, Feed, Sim, Browse]).pipe(Schema.toTaggedUnion("_tag"))
export type Shown = typeof Shown.Type

/**
 * The spool of one session: a counter that grows with each change, what is
 * shown, the tally, and the Sideshow session the pane's feed follows (the
 * caller's own, found on a call): the pane shows the feed when nothing else
 * is shown, goes back to it when a live view is closed, and records each
 * live view in it.
 */
export const Spooled = Schema.Struct({
  seq: Schema.Int,
  shown: Schema.optional(Shown),
  tally: Schema.optional(Tally),
  feed: Schema.optional(Feed),
})
export type Spooled = typeof Spooled.Type

/** A session's spool before its first call. */
export const empty: Spooled = { seq: 0 }

/** `spooled` showing `shown` instead, its tally kept; a Sideshow session shown is the feed from now on. */
export const show = (spooled: Spooled, shown: Shown): Spooled => ({
  ...spooled,
  seq: spooled.seq + 1,
  shown,
  feed: Option.getOrElse(Option.liftPredicate(shown, Shown.guards.Feed), () => spooled.feed),
})

/** `spooled` with `feed` as its feed when it has none yet: a feed followed on purpose is not replaced by the caller's own. What it shows is kept. */
export const remember = (spooled: Spooled, feed: Feed): Spooled =>
  Option.match(Option.fromUndefinedOr(spooled.feed), { onNone: () => ({ ...spooled, seq: spooled.seq + 1, feed }), onSome: () => spooled })

/** The feed `spooled` shows: a Sideshow session shown, or its feed when nothing is shown. */
export const feedShown = (spooled: Spooled): Option.Option<Feed> =>
  Option.match(Option.fromUndefinedOr(spooled.shown), {
    onNone: () => Option.fromUndefinedOr(spooled.feed),
    onSome: (shown) => Option.liftPredicate(shown, Shown.guards.Feed),
  })

/** Whether two feeds are one: the same Sideshow session on the same server, asked as often. */
export const sameFeed = (one: Feed, other: Feed): boolean => one.base === other.base && one.session === other.session && one.every === other.every

/** The key a feed pane's state is kept under between its runs: its server and session. */
export const feedKey = (feed: Feed): string => `${feed.base}|${feed.session}`

/**
 * Whether `spooled` still shows `feed`: a write that keeps it (a tally, the
 * feed remembered, the same feed shown again) leaves its pane running; one
 * that shows something else, or another feed, ends it.
 */
export const keepsFeed = (spooled: Spooled, feed: Feed): boolean => Option.exists(feedShown(spooled), (now) => sameFeed(now, feed))

/** `spooled` with `tally` instead, what it shows kept. */
export const count = (spooled: Spooled, tally: Tally): Spooled => ({ ...spooled, seq: spooled.seq + 1, tally })

/** The tally of `spooled`, if one was set. */
export const tallyOf = (spooled: Spooled): Option.Option<Tally> => Option.fromUndefinedOr(spooled.tally)

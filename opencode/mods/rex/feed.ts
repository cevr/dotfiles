// A Sideshow session in the showcase pane: the viewer asks for its posts
// every few seconds and draws the latest (the one updated last), by its
// first surface: an image as the picture itself, Markdown as styled text, a
// surface Sideshow renders as a page of its own (html, mermaid, diff,
// terminal, code) as a shot of that page, and anything else (json, trace)
// as the post flattened to Markdown. The tally counts the posts.
import { Array as Arr, Data, Option, Order, Schema } from "effect"
import type { Post } from "./service.ts"
import type { Tally } from "./status.ts"

/** How often the viewer asks Sideshow for new posts by default, in seconds. */
export const FEED_EVERY = 3

/** How wide a post's page is shot, in pixels: about the width Sideshow's viewer gives a card. */
export const FEED_WIDTH = 1000

/** How long a surface page's scripts may run before its shot (a Mermaid diagram draws after the page loads), in ms. */
export const SETTLE_MS = 5_000

/** The surface kinds Sideshow serves as a page of their own at `/p/<post>?surface=<n>`, other than Markdown. */
const PAGE_KINDS = new Set(["html", "mermaid", "diff", "terminal", "code"])

/** How the viewer draws a post. */
export type Draw = Data.TaggedEnum<{
  /** An uploaded image: its bytes when a PNG, else a shot of its address. */
  Asset: { readonly id: string; readonly url: string }
  /** Markdown, drawn as styled text. */
  Markdown: { readonly text: string }
  /** A page to shoot, letting its scripts run first. */
  Shoot: { readonly url: string }
  /** The post flattened to Markdown by Sideshow. */
  Flatten: { readonly post: string }
}>
export const Draw = Data.taggedEnum<Draw>()

/** The post updated last; of two updated at once, the one listed later. None when there are no posts. */
export const latest = (posts: ReadonlyArray<Post>): Option.Option<Post> =>
  Arr.reduce(posts, Option.none<Post>(), (best, post) =>
    Option.match(best, {
      onNone: () => Option.some(post),
      onSome: (kept) => Option.some(Option.match(Option.liftPredicate(post, (next) => next.updatedAt >= kept.updatedAt), { onNone: () => kept, onSome: (next) => next })),
    }),
  )

/** How `post`, on the server at `base`, is drawn: by its first surface. */
export const drawOf = (post: Post, base: string): Draw =>
  Option.match(Arr.head(post.surfaces), {
    onNone: () => Draw.Flatten({ post: post.id }),
    onSome: (surface) => {
      const asset = Option.filter(Option.fromUndefinedOr(surface.assetId), () => surface.kind === "image")
      const markdown = Option.filter(Option.fromUndefinedOr(surface.markdown), () => surface.kind === "markdown")
      if (Option.isSome(asset)) return Draw.Asset({ id: asset.value, url: `${base}/a/${asset.value}` })
      if (Option.isSome(markdown)) return Draw.Markdown({ text: markdown.value })
      if (PAGE_KINDS.has(surface.kind)) return Draw.Shoot({ url: `${base}/p/${post.id}?surface=${surface.index}&ver=${post.version}` })
      return Draw.Flatten({ post: post.id })
    },
  })

/** What the drawn post is, to tell when it changed: its id and version. */
export const printOf = (post: Post): string => `${post.id}@${post.version}`

/** The tally a followed session reports: how many posts, and the latest's title. */
export const tallyFor = (count: number, post: Option.Option<Post>): Tally => ({
  msg: Option.match(post, {
    onNone: () => "no posts yet",
    onSome: (shown) => `${count} ${Option.match(Option.liftPredicate(count, (n) => n === 1), { onNone: () => "posts", onSome: () => "post" })} · ${shown.title}`,
  }),
  state: "working",
})

/** One session in Sideshow's list: its id, title, the folder its agent ran in, and when it was last active. */
export const SessionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
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

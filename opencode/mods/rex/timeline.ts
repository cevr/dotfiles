// A Sideshow session as the feed pane shows it: the board, the one post
// titled "Board" that agents keep current with `sideshow update` (the one
// updated last, when there are several); the timeline, every other post
// newest first by when it was published (a revised post keeps its place and
// counts its versions); and a post's versions oldest first, to step through
// how it evolved. Sideshow has no pin flag, so the title marks the board.
import { Array as Arr, DateTime, Option, Order } from "effect"
import type { Post, PostDetail, Surface, Version } from "./service.ts"

/** The title that marks a session's board. */
export const BOARD_TITLE = "Board"

/** Whether `post` is titled as a board (case and spaces aside). */
export const isBoard = (post: Post): boolean => post.title.trim().toLowerCase() === BOARD_TITLE.toLowerCase()

/** When `post` was published: its creation, else its last update for a server that does not say. */
export const publishedAt = (post: Post): string => Option.getOrElse(Option.fromUndefinedOr(post.createdAt), () => post.updatedAt)

/** The session's board: of the posts titled Board, the one updated last (the later listed of a tie); none when there is none. */
export const boardOf = (posts: ReadonlyArray<Post>): Option.Option<Post> =>
  Arr.reduce(posts.filter(isBoard), Option.none<Post>(), (best, post) =>
    Option.some(Option.match(best, { onNone: () => post, onSome: (kept) => Option.match(Option.liftPredicate(post, (next) => next.updatedAt >= kept.updatedAt), { onNone: () => kept, onSome: (next) => next }) })),
  )

/** The timeline: every post but the board, newest published first; of two published at once, the later listed first. */
export const timelineOf = (posts: ReadonlyArray<Post>): ReadonlyArray<Post> => {
  const board = Option.map(boardOf(posts), (post) => post.id)
  const listed = posts.flatMap((post, at) => Option.match(Option.liftPredicate(post, (each) => !Option.contains(board, each.id)), { onNone: () => [], onSome: () => [{ post, at }] }))
  const newest = Order.combine(
    Order.flip(Order.mapInput(Order.String, ({ post }: { readonly post: Post; readonly at: number }) => publishedAt(post))),
    Order.flip(Order.mapInput(Order.Number, ({ at }: { readonly post: Post; readonly at: number }) => at)),
  )
  return Arr.sort(listed, newest).map(({ post }) => post)
}

/** A post's versions, oldest first: those Sideshow kept, then the current one; each version once. */
export const versionsOf = (detail: PostDetail): ReadonlyArray<Version> => {
  const current: Version = { version: detail.version, title: detail.title, surfaces: detail.surfaces, at: detail.updatedAt }
  const all = [...detail.history.filter((kept) => kept.version !== detail.version), current]
  return Arr.dedupeWith(Arr.sort(all, Order.mapInput(Order.Number, (kept: Version) => kept.version)), (a, b) => a.version === b.version)
}

/** The version `steps` away from `at` in `versions` (negative: older), held at the oldest and the newest; the newest when `at` is not among them. */
export const stepVersion = (versions: ReadonlyArray<Version>, at: Option.Option<number>, steps: number): Option.Option<number> => {
  const index = Option.getOrElse(
    Option.flatMap(at, (version) => Arr.findFirstIndex(versions, (kept) => kept.version === version)),
    () => versions.length - 1,
  )
  return Option.map(Arr.get(versions, Math.min(versions.length - 1, Math.max(0, index + steps))), (kept) => kept.version)
}

/** An ISO time in ms; `fallback` for a time that does not parse. */
export const millisOf = (time: string, fallback: number): number => Option.getOrElse(Option.map(DateTime.make(time), DateTime.toEpochMillis), () => fallback)

/** How long ago `then` was at `now` (both ms), shortest: now, 12s, 3m, 2h, 4d. */
export const ageOf = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 5) return "now"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** One letter-wide sign for each surface kind, so a timeline row says what a post holds. */
const ICONS = new Map([["markdown", "¶"], ["mermaid", "◇"], ["diff", "±"], ["image", "▣"], ["html", "◧"], ["code", "ƒ"], ["terminal", "›"], ["json", "{"], ["trace", "≋"]])

/** The sign of a surface kind; `·` for a kind this pane does not know. */
export const iconOf = (kind: string): string => Option.getOrElse(Option.fromUndefinedOr(ICONS.get(kind)), () => "·")

/** The signs of a post's surfaces, in order. */
export const iconsOf = (surfaces: ReadonlyArray<Surface>): string => surfaces.map((surface) => iconOf(surface.kind)).join("")

/** One row of the timeline: its post, its signs, its age, how many versions it has, and whether it came since the pane first looked and was not viewed yet. */
export interface Row {
  readonly id: string
  readonly title: string
  readonly icons: string
  readonly age: string
  readonly versions: number
  readonly fresh: boolean
}

/** The timeline's rows at `now`, `fresh` holding the posts not viewed since they came. */
export const rowsOf = (timeline: ReadonlyArray<Post>, now: number, fresh: ReadonlySet<string>): ReadonlyArray<Row> =>
  timeline.map((post) => ({
    id: post.id,
    title: post.title,
    icons: iconsOf(post.surfaces),
    age: ageOf(millisOf(publishedAt(post), now), now),
    versions: post.version,
    fresh: fresh.has(post.id),
  }))

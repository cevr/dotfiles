// The contracts rex-show needs from outside: Rex, which holds the session's
// panes; the spool, where a call leaves what the showcase pane draws; and a
// headless browser, which shoots the web page the pane shows; and Sideshow,
// whose session the pane follows.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Block } from "./showcase.ts"
import type { Spooled } from "./spool.ts"

/** Rex refused a call or could not be reached; the command and its words. */
export class RexFailed extends Schema.TaggedError<RexFailed>()("RexFailed", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** The spool could not be read or written. */
export class SpoolFailed extends Schema.TaggedError<SpoolFailed>()("SpoolFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A web page could not be shot: unreachable, no browser on this host, or the browser failed; the page and why, for the pane's error line. */
export class ShotFailed extends Schema.TaggedError<ShotFailed>()("ShotFailed", {
  url: Schema.String,
  message: Schema.String,
}) {}

/** One screenshot to take: the page, the viewport in pixels, and how long its scripts may run first (ms of the page's own time; none: shot once it loads). */
export interface Shot {
  readonly url: string
  readonly width: number
  readonly height: number
  readonly settle?: number
}

/** Sideshow could not be reached, or did not know what was asked; where, and why, for the pane's error line. */
export class SideshowFailed extends Schema.TaggedError<SideshowFailed>()("SideshowFailed", {
  base: Schema.String,
  message: Schema.String,
}) {}

/** One surface of a post, as Sideshow lists it: its kind and place, a markdown surface's text, an image's asset. */
export const Surface = Schema.Struct({
  kind: Schema.String,
  index: Schema.Int,
  markdown: Schema.optional(Schema.String),
  assetId: Schema.optional(Schema.String),
})
export type Surface = typeof Surface.Type

/** One post of a session, as Sideshow lists it. */
export const Post = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  version: Schema.Int,
  updatedAt: Schema.String,
  surfaces: Schema.Array(Surface),
})
export type Post = typeof Post.Type

/** One Sideshow server, read only. */
export interface SideshowServer {
  /** The title of `session`; none when the server does not know it. */
  readonly title: (session: string) => Effect.Effect<Option.Option<string>, SideshowFailed>
  /** The posts of `session`, in the order Sideshow lists them. */
  readonly posts: (session: string) => Effect.Effect<ReadonlyArray<Post>, SideshowFailed>
  /** The bytes of an uploaded asset. */
  readonly asset: (id: string) => Effect.Effect<Uint8Array, SideshowFailed>
  /** A post flattened to Markdown, as Sideshow's share menu copies it. */
  readonly markdown: (post: string) => Effect.Effect<string, SideshowFailed>
}

/** Sideshow as this host's `sideshow` CLI sees it (`$SIDESHOW_URL`, else localhost:8228), and any server by its address. */
export class Sideshow extends Context.Service<
  Sideshow,
  {
    /** The address the CLI publishes to; posts' pages and assets are found under it. */
    readonly base: string
    /** The session the `sideshow` CLI would publish to from this process's shell, if it has one yet. */
    readonly mine: Effect.Effect<Option.Option<string>, SideshowFailed>
    /** The server at `base`; the CLI's token is sent only to the CLI's own address. */
    readonly at: (base: string) => SideshowServer
  }
>()("dotfiles-opencode/rex/Sideshow") {}

/** A headless browser on this host, with a profile of its own (never the owner's). */
export class Browser extends Context.Service<
  Browser,
  {
    /** The page at `shot.url` as a PNG of `shot.width` × `shot.height` pixels. */
    readonly shoot: (shot: Shot) => Effect.Effect<Uint8Array, ShotFailed>
  }
>()("dotfiles-opencode/rex/Browser") {}

/** Where a new pane goes and what runs in it. */
export interface Split {
  /** The session, by full id. */
  readonly session: string
  /** The block the new pane opens beside. */
  readonly beside: string
  /** The new pane's label. */
  readonly label: string
  /** The program the new pane runs, and its arguments. */
  readonly command: ReadonlyArray<string>
}

/** One Rex server's sessions and panes, as far as rex-show uses them. */
export class Rex extends Context.Service<
  Rex,
  {
    /** Every block of `session`, placed or detached. */
    readonly blocks: (session: string) => Effect.Effect<ReadonlyArray<Block>, RexFailed>
    /** A new pane beside another, without taking focus; its block id. */
    readonly split: (split: Split) => Effect.Effect<string, RexFailed>
    /** Closes a block; one already gone is no failure. */
    readonly close: (session: string, block: string) => Effect.Effect<void, RexFailed>
    /** Whether a terminal block's program still runs: a pane whose program ended stays open, showing it exited. */
    readonly running: (session: string, block: string) => Effect.Effect<boolean, RexFailed>
  }
>()("dotfiles-opencode/rex/Rex") {}

/** What each session's showcase draws, kept between calls. */
export class Spool extends Context.Service<
  Spool,
  {
    /** What `session`'s showcase draws now, if anything was spooled. */
    readonly read: (session: string) => Effect.Effect<Spooled, SpoolFailed>
    /** Replaces what `session`'s showcase draws. */
    readonly write: (session: string, spooled: Spooled) => Effect.Effect<void, SpoolFailed>
    /** Keeps a copy of `file` for `session`'s showcase; the copy's path. */
    readonly keep: (session: string, file: string) => Effect.Effect<string, SpoolFailed>
  }
>()("dotfiles-opencode/rex/Spool") {}

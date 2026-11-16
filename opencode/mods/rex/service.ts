// The contracts rex-show needs from outside: Rex, which holds the session's
// panes; the spool, where a call leaves what the showcase pane draws; and a
// headless browser, which shoots the web page the pane shows; and Sideshow,
// whose session the pane follows; the iOS simulators the pane mirrors; the
// Mermaid diagrams it draws; and the host's way to open a page for the owner.
import { Context, type Effect, type Option, Schema, type Scope } from "effect"
import type { Block } from "./showcase.ts"
import type { Device } from "./sim.ts"
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

/**
 * One surface of a post, as Sideshow lists it: its kind and place, and its
 * body by kind (Sideshow leaves an html surface's body out of a list): a
 * markdown surface's text, a Mermaid diagram's source, a diff's patch, a
 * terminal's text, code and its language, a json surface's data, an image's
 * asset.
 */
export const Surface = Schema.Struct({
  kind: Schema.String,
  index: Schema.Int,
  markdown: Schema.optional(Schema.String),
  mermaid: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Json),
  assetId: Schema.optional(Schema.String),
})
export type Surface = typeof Surface.Type

/** One post of a session, as Sideshow lists it: `version` counts its versions (each `sideshow update` adds one). */
export const Post = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  version: Schema.Int,
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  surfaces: Schema.Array(Surface),
})
export type Post = typeof Post.Type

/** One earlier version of a post, as Sideshow keeps it (the last 20). */
export const Version = Schema.Struct({
  version: Schema.Int,
  title: Schema.String,
  surfaces: Schema.Array(Surface),
  at: Schema.String,
})
export type Version = typeof Version.Type

/** One post with its earlier versions, as Sideshow sends one post. */
export const PostDetail = Schema.Struct({
  ...Post.fields,
  history: Schema.Array(Version),
})
export type PostDetail = typeof PostDetail.Type

/** A post the viewer records in a session: its title and surfaces, as Sideshow takes them. */
export interface Entry {
  readonly session: string
  readonly title: string
  readonly surfaces: ReadonlyArray<{ readonly [key: string]: string }>
}

/** One Sideshow server. */
export interface SideshowServer {
  /** The title of `session`; none when the server does not know it. */
  readonly title: (session: string) => Effect.Effect<Option.Option<string>, SideshowFailed>
  /** The posts of `session`, in the order Sideshow lists them. */
  readonly posts: (session: string) => Effect.Effect<ReadonlyArray<Post>, SideshowFailed>
  /** One post with its earlier versions. */
  readonly post: (id: string) => Effect.Effect<PostDetail, SideshowFailed>
  /** The bytes of an uploaded asset. */
  readonly asset: (id: string) => Effect.Effect<Uint8Array, SideshowFailed>
  /** A post flattened to Markdown, as Sideshow's share menu copies it. */
  readonly markdown: (post: string) => Effect.Effect<string, SideshowFailed>
  /** A comment on `post` from the user, as Sideshow's own viewer sends one: an agent's `sideshow wait` or `watch` gets it. */
  readonly comment: (post: string, text: string) => Effect.Effect<void, SideshowFailed>
  /** A PNG uploaded to `session`; its asset id. */
  readonly upload: (session: string, png: Uint8Array) => Effect.Effect<string, SideshowFailed>
  /** A new post; its id. */
  readonly publish: (entry: Entry) => Effect.Effect<string, SideshowFailed>
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
    /** A live tab on `url`, set up by `setup` before it loads (its viewport, its screencast); the browser lives as long as the scope. */
    readonly open: (url: string, setup: ReadonlyArray<Command>) => Effect.Effect<Tab, ShotFailed, Scope.Scope>
  }
>()("dotfiles-opencode/rex/Browser") {}

/** A JSON value, as a DevTools protocol command's parameters are. */
export type Json = string | number | boolean | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** One DevTools protocol command for a live tab: its method and parameters. */
export interface Command {
  readonly method: string
  readonly params: { readonly [key: string]: Json }
}

/** One screencast frame of a live tab: a PNG in base64, and the tab's viewport it shows, in CSS pixels. */
export interface Frame {
  readonly data: string
  readonly width: number
  readonly height: number
}

/** A live tab in a headless browser. Each wait fails once the browser is gone. */
export interface Tab {
  /** The next frame after the last one taken (frames that came between are dropped). */
  readonly frame: Effect.Effect<Frame, ShotFailed>
  /** The page's address after its next navigation (links, history, reload). */
  readonly url: Effect.Effect<string, ShotFailed>
  /** `commands` sent in order, each answered before the next. */
  readonly send: (commands: ReadonlyArray<Command>) => Effect.Effect<void, ShotFailed>
  /** What `expression` evaluates to in the page. */
  readonly ask: (expression: string) => Effect.Effect<unknown, ShotFailed>
}

/** The simulators could not be listed or screenshot: no Mac, ssh refused, or simctl failed; why, for the pane's error line. */
export class SimFailed extends Schema.TaggedError<SimFailed>()("SimFailed", {
  message: Schema.String,
}) {}

/** The iOS simulators of one Mac, read only: never booted, shut down, installed to or erased. */
export interface SimHost {
  /** The booted simulators. */
  readonly booted: Effect.Effect<ReadonlyArray<Device>, SimFailed>
  /** A PNG of simulator `udid`'s screen. */
  readonly screenshot: (udid: string) => Effect.Effect<Uint8Array, SimFailed>
}

/** The iOS simulators this host can reach: its own on a Mac, or a Mac's over ssh. */
export class Simulators extends Context.Service<
  Simulators,
  {
    /** The simulators on `host` (user@mac, reached with ssh), or on this host when it is "". */
    readonly at: (host: string) => SimHost
  }
>()("dotfiles-opencode/rex/Simulators") {}

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
  /** The folder it runs in (Rex's default when absent). */
  readonly cwd?: string
}

/** A Mermaid diagram could not be drawn: its source does not parse, or its page could not be written; why, for the pane. */
export class DiagramFailed extends Schema.TaggedError<DiagramFailed>()("DiagramFailed", {
  message: Schema.String,
}) {}

/** Mermaid diagrams drawn on this host, as a page the headless browser shoots. */
export class Diagrams extends Context.Service<
  Diagrams,
  {
    /** A page holding `source` drawn `width` pixels wide, light on dark as the pane is: its address and its size in pixels, to shoot it whole. */
    readonly page: (source: string, width: number) => Effect.Effect<{ readonly url: string; readonly width: number; readonly height: number }, DiagramFailed>
  }
>()("dotfiles-opencode/rex/Diagrams") {}

/** A web address could not be opened on this host; why. */
export class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {
  message: Schema.String,
}) {}

/** This host's way to open a web address in the owner's browser. */
export class Opener extends Context.Service<
  Opener,
  {
    /** `url` opened in this host's browser. */
    readonly open: (url: string) => Effect.Effect<void, OpenFailed>
  }
>()("dotfiles-opencode/rex/Opener") {}

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

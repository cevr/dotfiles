// The contracts rex-show needs from outside: Rex, which holds the session's
// panes, and the spool, where a call leaves what the showcase pane draws.
// `laws.ts` states what every Rex owes.
import { Context, type Effect, Schema } from "effect"
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

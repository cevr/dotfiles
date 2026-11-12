// The contract idle compaction needs from outside: what a session's data says
// about its cache, and the host's compaction. Each operation states its
// failure; `laws.ts` states what every implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { Facts } from "./idle.ts"

/** The host could not say what a session holds. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host would not start a session's compaction. */
export class CompactionRefused extends Schema.TaggedError<CompactionRefused>()("CompactionRefused", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host could not read the catalog this copy's decisions read lifetimes, windows and prices from. */
export class CatalogUnreadable extends Schema.TaggedError<CatalogUnreadable>()("CatalogUnreadable", {
  message: Schema.String,
}) {}

/** What the session's own record says, read without its context or its children. */
export interface Standing {
  /** The session is in this copy's location: its idle windows are this copy's to decide. */
  readonly serves: boolean
  /** It is a subagent's session. */
  readonly child: boolean
  /** An execution of it runs. */
  readonly running: boolean
}

/**
 * The host's sessions, as idle compaction reads and compacts them. The host runs one copy of the plugin per location
 * (directory and workspace) it serves, each on its own `Sessions`; every copy hears every session's events, but only
 * the copy of a session's own location is told its hooks, so that copy is the one that decides for it.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** Whose the session is and whether it could compact at all, from its record alone: cheap, so read first. */
    readonly standing: (sessionID: string) => Effect.Effect<Standing, SessionUnreadable>
    /**
     * What the session's data says now. `last.startedAt` is the data's best time for the request's start; the model
     * adds what only the plugin saw (a request's exact start, background jobs, its own compactions). It reads the
     * session's whole context: the costly read, made only for a session its standing does not rule out.
     */
    readonly facts: (sessionID: string) => Effect.Effect<Facts, SessionUnreadable>
    /** Starts the host's own compaction of the session; it runs when the session is next free. */
    readonly compact: (sessionID: string) => Effect.Effect<void, CompactionRefused>
    /** The main sessions this copy serves worth a look when the plugin starts, newest first. */
    readonly recent: Effect.Effect<ReadonlyArray<string>, SessionUnreadable>
    /**
     * The catalog of this copy's location as its decisions read it (lifetimes, windows, prices), as one key: two
     * reads with the same key decide every session alike, so a catalog change that leaves it equal needs no look.
     */
    readonly catalog: Effect.Effect<string, CatalogUnreadable>
  }
>()("dotfiles-opencode/idle-compact/Sessions") {}

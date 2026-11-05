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

/**
 * The host's sessions, as idle compaction reads and compacts them. The host runs one copy of the plugin per location
 * (directory and workspace) it serves, each on its own `Sessions`; every copy hears every session's events, but only
 * the copy of a session's own location is told its hooks, so that copy is the one that decides for it.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** Whether the session is in this copy's location: its idle windows are this copy's to decide. */
    readonly serves: (sessionID: string) => Effect.Effect<boolean, SessionUnreadable>
    /**
     * What the session's data says now. `last.startedAt` is the data's best time for the request's start; the model
     * adds what only the plugin saw (a request's exact start, background jobs, its own compactions).
     */
    readonly facts: (sessionID: string) => Effect.Effect<Facts, SessionUnreadable>
    /** Starts the host's own compaction of the session; it runs when the session is next free. */
    readonly compact: (sessionID: string) => Effect.Effect<void, CompactionRefused>
    /** The main sessions this copy serves worth a look when the plugin starts, newest first. */
    readonly recent: Effect.Effect<ReadonlyArray<string>, SessionUnreadable>
  }
>()("dotfiles-opencode/idle-compact/Sessions") {}

// The contracts auto-title needs from outside: the host's sessions and title
// generation, and a store for what it keeps of each session. Each operation
// states its failure; `laws.ts` states what every store owes.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Standing, Track } from "./retitle.ts"

/** The host could not say what a session is. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host's title request failed or was refused; the old title stays. */
export class TitleFailed extends Schema.TaggedError<TitleFailed>()("TitleFailed", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** Whose session it is and what it does now. */
export interface Seat extends Standing {
  /** The session is in this copy's location: its titles are this copy's to decide. */
  readonly serves: boolean
}

/**
 * The host's sessions. The host runs one copy of the plugin per location (directory and workspace); every copy hears
 * every session's events, but a session's hooks reach only its own location's copy, which alone decides for it.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly seat: (sessionID: string) => Effect.Effect<Seat, SessionUnreadable>
    /** Generates the session's title again through the host's own title path, from its request and recent turns. */
    readonly retitle: (sessionID: string) => Effect.Effect<void, TitleFailed>
  }
>()("dotfiles-opencode/auto-title/Sessions") {}

/** What the plugin keeps of each root session it titles. Reads and writes never fail: a lost entry starts fresh. */
export class Tracks extends Context.Service<
  Tracks,
  {
    readonly get: (sessionID: string) => Effect.Effect<Option.Option<Track>>
    readonly put: (sessionID: string, track: Track) => Effect.Effect<void>
    readonly remove: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/auto-title/Tracks") {}

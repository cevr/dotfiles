// The contracts memory needs from outside: a store for the notes and each
// session's digest, and what the host says about a session. What every
// NoteStore owes is in laws.ts.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Bucket, Draft, Note } from "./note.ts"

/** The store could not be read or written. */
export class MemoryStoreFailed extends Schema.TaggedError<MemoryStoreFailed>()("MemoryStoreFailed", { message: Schema.String }) {}

/** The host could not say what a session is. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** Which counter a read moves: `uses` for a search or a repeated save, `shown` for a digest. Both set `used`. */
export type Reading = "uses" | "shown"

/**
 * The notes, one store per host (several server processes and copies of the plugin share it), and the digest each
 * session started with.
 * - `add` gives the draft a new id, higher than every earlier one.
 * - `put` replaces the note of that id whole; one that is gone stays gone.
 * - `match` answers the notes in `within` whose text or tags match the full-text `query` (FTS5 syntax, as
 *   `matchQuery` writes it), best match first, at most `limit`.
 * - `list` answers the notes, in `within` when given, most recently updated first, at most `limit` when given.
 * - `read` adds one to each note's `reading` counter and sets its `used` to `now`.
 * - `keepDigest` keeps the session's digest the first time it is asked and answers the kept one ever after, with
 *   `fresh` true only for the call that kept it: whichever copy of the plugin asks first decides.
 * - `keptDigest` answers the session's kept digest, none when none is kept yet, and writes nothing: a store whose
 *   writes fail still answers it.
 */
export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly add: (draft: Draft) => Effect.Effect<Note, MemoryStoreFailed>
    readonly put: (note: Note) => Effect.Effect<void, MemoryStoreFailed>
    readonly get: (id: number) => Effect.Effect<Note | undefined, MemoryStoreFailed>
    /** Whether a note went. */
    readonly remove: (id: number) => Effect.Effect<boolean, MemoryStoreFailed>
    readonly match: (query: string, within: ReadonlyArray<Bucket>, limit: number) => Effect.Effect<ReadonlyArray<Note>, MemoryStoreFailed>
    readonly list: (options: { readonly within?: ReadonlyArray<Bucket>; readonly limit?: number }) => Effect.Effect<ReadonlyArray<Note>, MemoryStoreFailed>
    readonly read: (ids: ReadonlyArray<number>, reading: Reading, now: number) => Effect.Effect<void, MemoryStoreFailed>
    readonly keepDigest: (
      sessionID: string,
      text: string,
      now: number,
    ) => Effect.Effect<{ readonly text: string; readonly fresh: boolean }, MemoryStoreFailed>
    readonly keptDigest: (sessionID: string) => Effect.Effect<Option.Option<string>, MemoryStoreFailed>
  }
>()("dotfiles-opencode/memory/NoteStore") {}

/** What memory needs to know of a session: its project (OpenCode's project id), its directory, and whether it is a subagent's. */
export interface SessionFacts {
  readonly project: string
  readonly directory: string
  readonly child: boolean
  /** The digest the session holds itself (`hold`), for when the memory file could not keep one. */
  readonly held: Option.Option<string>
}

/**
 * OpenCode's sessions: `facts` reads one; `hold` keeps a digest on the session itself, in the host's session store,
 * so a copy that starts after a restart sends the digest the memory file could not keep.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly facts: (sessionID: string) => Effect.Effect<SessionFacts, SessionUnreadable>
    readonly hold: (sessionID: string, digest: string) => Effect.Effect<void, SessionUnreadable>
  }
>()("dotfiles-opencode/memory/Sessions") {}

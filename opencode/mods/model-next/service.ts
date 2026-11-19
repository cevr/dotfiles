// The contract the queued switch needs from outside: a session's record (its
// model and metadata), the host's model switch, the catalog's entry for a
// model, and what the session's data says of its cache. Each operation states
// its failure; `laws.ts` states what every implementation owes.
import { Context, type Effect, type Option, Schema } from "effect"
import type { CacheFacts, CatalogEntry, Metadata, ModelRef } from "./pending.ts"

/** The host could not say what a session holds. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host would not change the session's model or metadata. */
export class SessionUnwritable extends Schema.TaggedError<SessionUnwritable>()("SessionUnwritable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host could not read the catalog. */
export class CatalogUnreadable extends Schema.TaggedError<CatalogUnreadable>()("CatalogUnreadable", {
  message: Schema.String,
}) {}

/** A session's own record, as the queued switch reads it. */
export interface SessionRecord {
  /** The model its next request goes to: its selection, else the host's default. */
  readonly model: ModelRef
  /** Its metadata, whole: a write replaces it whole, so a writer merges into what this read. */
  readonly metadata: Metadata
}

export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's record; none when the host has no such session. */
    readonly record: (sessionID: string) => Effect.Effect<Option.Option<SessionRecord>, SessionUnreadable>
    /** Replaces the session's metadata whole (the host's `session.update`). */
    readonly setMetadata: (sessionID: string, metadata: Metadata) => Effect.Effect<void, SessionUnwritable>
    /** Selects the session's model (the host's `switchModel`): its next request goes there. The catalog is not checked. */
    readonly switchModel: (sessionID: string, model: ModelRef) => Effect.Effect<void, SessionUnwritable>
    /** The catalog's entry for the model, in the session's location; none when the catalog lacks it. */
    readonly entry: (sessionID: string, model: ModelRef) => Effect.Effect<Option.Option<CatalogEntry>, CatalogUnreadable>
    /** What the session's data says of its prompt cache: its last request since the last compaction, and whether a compaction came after it. */
    readonly cache: (sessionID: string) => Effect.Effect<CacheFacts, SessionUnreadable>
  }
>()("dotfiles-opencode/model-next/Sessions") {}

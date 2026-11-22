// The contracts the queue needs from outside: somewhere to keep each session's
// queue (what every implementation owes is in laws.ts), and the host the
// staleness sweep reads and sends its note through.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Snapshot } from "./queue.ts"
import type { Linked } from "./stale.ts"

/** A session's stored queue exists but could not be read. */
export class QueueUnreadable extends Schema.TaggedError<QueueUnreadable>()("QueueUnreadable", { message: Schema.String }) {}

/** A session's queue could not be written or removed. */
export class QueueUnwritable extends Schema.TaggedError<QueueUnwritable>()("QueueUnwritable", { message: Schema.String }) {}

/**
 * Each session's queue, keyed by its session id. A session with none reads as
 * `EMPTY`; a write replaces it whole, so a reader sees the old queue or the
 * new one, never a mix; `remove` forgets it, and removing none is no failure.
 */
export class QueueStore extends Context.Service<
  QueueStore,
  {
    readonly read: (sessionID: string) => Effect.Effect<Snapshot, QueueUnreadable>
    readonly write: (sessionID: string, snapshot: Snapshot) => Effect.Effect<void, QueueUnwritable>
    readonly remove: (sessionID: string) => Effect.Effect<void, QueueUnwritable>
  }
>()("dotfiles-opencode/queue/QueueStore") {}

/** A root session of this location: whether a turn runs now, and when it last changed (epoch ms). */
export interface Root {
  readonly id: string
  readonly busy: boolean
  readonly updated: number
}

/** What a note into a session is: the sweep's staleness check, or the owner's answer to an item. */
export type NoteKind = "staleness" | "answer"

/** The host would not take the note. */
export class NoteRefused extends Schema.TaggedError<NoteRefused>()("NoteRefused", { sessionID: Schema.String, message: Schema.String }) {}

/**
 * What orchestrate says of lost work (its `lost` RPC): the lines `orchestrate status` starts with, for a root that runs
 * units, with one stable key per loss; and why each commit the queue names is not on the default branch past the
 * threshold, by commit.
 */
export interface Lost {
  readonly lines: ReadonlyArray<string>
  readonly keys: ReadonlyArray<string>
  readonly hashes: ReadonlyMap<string, string>
}

/**
 * The host as the staleness sweep sees it. Every read answers what it can:
 * a host or plugin that does not answer is `Option.none()` (or no roots),
 * never a failure, so one silent neighbour costs only its own facts.
 */
export class QueueHost extends Context.Service<
  QueueHost,
  {
    /** This location's root sessions, the most recently changed first. */
    readonly roots: Effect.Effect<ReadonlyArray<Root>>
    /** A subagent session's state; none when the host could not say. */
    readonly linked: (sessionID: string) => Effect.Effect<Option.Option<Linked>>
    /** The ids of the alarms and monitors each session has pending (the wakes plugin's `pending`). */
    readonly wakes: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<Option.Option<ReadonlyMap<string, ReadonlyArray<string>>>>
    /** How many ask_user_async questions each session has open (the questions plugin's `open`). */
    readonly questions: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<Option.Option<ReadonlyMap<string, number>>>
    /** What orchestrate says of lost work for the session and of the commits `hashes` its queue names (the orchestrate plugin's `lost`); none without it. */
    readonly lost: (sessionID: string, hashes: ReadonlyArray<string>) => Effect.Effect<Option.Option<Lost>>
    /** Put the note into the session: waking it when `wake`, else read at its next turn. `kind` says what it is: a staleness check or the owner's answer to an item. */
    readonly note: (sessionID: string, text: string, description: string, wake: boolean, kind: NoteKind) => Effect.Effect<void, NoteRefused>
  }
>()("dotfiles-opencode/queue/QueueHost") {}

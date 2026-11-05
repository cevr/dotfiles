// The contracts the kernel needs from outside: the worker processes, the store
// of each session's bindings, OpenCode's sessions and agents, the tools of the
// call at hand, and the files a cell attaches. Each states its failures;
// `laws.ts` states what every implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { FileTooLarge, FileUnreadable } from "./attachment.ts"
import type { Evaluation, Json, Listing, Snapshot, SnapshotBinding } from "./frame.ts"
import type { KernelSessionId } from "./session.ts"
import type { CallFailed, Rule } from "./tools.ts"

// ── Workers ──

/** The session's worker is gone: it exited, used its compute, did not start, broke the protocol or was stopped. */
export class WorkerLost extends Schema.TaggedError<WorkerLost>()("WorkerLost", { message: Schema.String }) {}

/** One cell to run: its source, the tools it may call, and how a call runs. */
export interface Cell {
  readonly source: string
  readonly tools: ReadonlyArray<Listing>
  readonly call: (name: string, input: Json) => Effect.Effect<Json, CallFailed>
}

/** One cell's outcome: what it wrote outside `console`, and its evaluation. */
export interface CellResult extends Evaluation {
  readonly output: string
}

/**
 * The worker processes, one per session, each in the session's working
 * directory. Every operation but `start` runs on the session's live worker and
 * fails with `WorkerLost` when it has none. A cell, a snapshot and a restore
 * run under the compute limit; past it the worker is killed. Interrupting a
 * cell kills its worker. A worker that is killed or dies takes every binding
 * since its last snapshot with it.
 */
export class Workers extends Context.Service<
  Workers,
  {
    /** Whether the session's worker runs. */
    readonly alive: (session: KernelSessionId) => Effect.Effect<boolean>
    /** Starts the session's worker in `directory`, ending any it had, and waits until it is ready. */
    readonly start: (session: KernelSessionId, directory: string) => Effect.Effect<void, WorkerLost>
    readonly evaluate: (session: KernelSessionId, cell: Cell) => Effect.Effect<CellResult, WorkerLost>
    /** The worker's bindings as structured clones, with those it could not encode named. */
    readonly snapshot: (session: KernelSessionId) => Effect.Effect<Snapshot, WorkerLost>
    /** Puts stored bindings back into the worker: the names it defined. */
    readonly restore: (session: KernelSessionId, bindings: ReadonlyArray<SnapshotBinding>) => Effect.Effect<ReadonlyArray<string>, WorkerLost>
    /** Kills the session's worker, if it has one. */
    readonly stop: (session: KernelSessionId) => Effect.Effect<void>
  }
>()("dotfiles-opencode/kernel/Workers") {}

// ── Snapshots ──

/**
 * Each session's stored bindings: the last snapshot of its worker, which a new
 * worker restores. A store that cannot be read, or holds something else,
 * holds no bindings.
 */
export class Snapshots extends Context.Service<
  Snapshots,
  {
    readonly load: (session: KernelSessionId) => Effect.Effect<ReadonlyArray<SnapshotBinding>>
    readonly save: (session: KernelSessionId, bindings: ReadonlyArray<SnapshotBinding>) => Effect.Effect<void>
    readonly drop: (session: KernelSessionId) => Effect.Effect<void>
  }
>()("dotfiles-opencode/kernel/Snapshots") {}

// ── Sessions ──

/** The host could not read the session. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  session: Schema.String,
  message: Schema.String,
}) {}

/** Where a session's worker runs, and the permission rules its cell's tools are filtered by. */
export interface Scope {
  readonly directory: string
  readonly rules: ReadonlyArray<Rule>
}

/** OpenCode's sessions and agents, as the kernel reads them. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's working directory, and its agent's rules then its own. An agent that cannot be read has no rules. */
    readonly scope: (session: KernelSessionId, agent: string) => Effect.Effect<Scope, SessionUnreadable>
  }
>()("dotfiles-opencode/kernel/Sessions") {}

// ── Toolbox ──

/** The tools one cell may call: what `tools.list()` shows, and the call itself. */
export interface CellTools {
  readonly listing: ReadonlyArray<Listing>
  readonly call: (id: string, input: Json) => Effect.Effect<Json, CallFailed>
}

/**
 * The tools of the kernel call at hand, provided for that call: through the
 * agent's runtime when the kernel is it, else each registered tool's own
 * `execute` with the call's context.
 */
export class Toolbox extends Context.Service<
  Toolbox,
  {
    /** The tools a cell reaches under `rules`. */
    readonly reach: (rules: ReadonlyArray<Rule>) => Effect.Effect<CellTools>
  }
>()("dotfiles-opencode/kernel/Toolbox") {}

// ── Files ──

/**
 * The files a cell attaches (attachment.ts), read after the cell. A path that
 * names no regular file, or one that cannot be read, fails `FileUnreadable`
 * with the reason; a file over `limit` bytes fails `FileTooLarge` unread.
 */
export class Files extends Context.Service<
  Files,
  {
    /** The bytes of the regular file at `path`, an absolute path, when it holds at most `limit` of them. */
    readonly read: (path: string, limit: number) => Effect.Effect<Uint8Array, FileUnreadable | FileTooLarge>
  }
>()("dotfiles-opencode/kernel/Files") {}

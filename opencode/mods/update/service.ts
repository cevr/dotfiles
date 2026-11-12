import { Context, type Effect, type Option, Schema } from "effect"
import type { SessionView } from "./gate.ts"
import type { Reading } from "./health.ts"
import type { Record } from "./record.ts"
import type { Target } from "./target.ts"
import type { Rejected, Running } from "./update.ts"

/** A step of an update failed: which, and what its command said. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

/**
 * The dotfiles checkout the host runs its plugins from (its warm source), and the verified target
 * on its origin. Nothing else moves the checkout: `advance` is the one move, the commit and the
 * dependencies together.
 */
export class Source extends Context.Service<
  Source,
  {
    /** Fetches the verified target; none while the origin names none. */
    readonly verified: Effect.Effect<Option.Option<Target>, UpdateFailed>
    /** The commit the checkout is on. */
    readonly head: Effect.Effect<string, UpdateFailed>
    /**
     * Moves the checkout to `commit` and installs its dependencies as its lockfile pins them. A
     * failed install moves the checkout back to where it was, so no plugin ever loads from a tree
     * whose dependencies are missing.
     */
    readonly advance: (commit: string) => Effect.Effect<void, UpdateFailed>
    /** Installs the checkout's dependencies again, as it stands. */
    readonly reinstall: Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Source") {}

/**
 * Builds the target ahead of the restart, from the advanced checkout's own install code (`bun
 * scripts/daily.ts --stage`): the fork at the target's commit, the binary, the config and the
 * installed record. It restarts nothing.
 */
export class Builder extends Context.Service<
  Builder,
  {
    readonly stage: (target: Target) => Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Builder") {}

/** The host's sessions, every location's, as the restart gate reads them. */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly all: Effect.Effect<ReadonlyArray<SessionView>, UpdateFailed>
  }
>()("dotfiles-opencode/update/Sessions") {}

/**
 * Hands the restart to a process of its own, which outlives the service it restarts: it restarts
 * the service, checks its health and recovers (`health.ts`).
 */
export class Handoff extends Context.Service<
  Handoff,
  {
    readonly start: (reason: string) => Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Handoff") {}

/**
 * The running handoff's mark (`update.ts` `Running`): the handoff holds it while it runs, and
 * every check reads it, with whether its process lives, before it plans. A mark that does not
 * write, or does not read, holds nothing: the check plans as before.
 */
export class HandoffMark extends Context.Service<
  HandoffMark,
  {
    /** Marks this process as the running handoff, from now. */
    readonly hold: Effect.Effect<void>
    /** Drops the mark, when it is this process's. */
    readonly release: Effect.Effect<void>
    readonly read: Effect.Effect<Option.Option<Running>>
    /** Whether process `pid` lives (read with `ps`, never a signal). */
    readonly alive: (pid: number) => Effect.Effect<boolean>
  }
>()("dotfiles-opencode/update/HandoffMark") {}

/** The installed record (`record.ts`). */
export class Records extends Context.Service<
  Records,
  {
    /** None when there is no record, or it does not read. */
    readonly read: Effect.Effect<Option.Option<Record>>
    readonly write: (record: Record) => Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Records") {}

/**
 * The target this host failed on (`update.ts` `Rejected`), in the update's own directory: a failed
 * advance or build, or a restart that did not prove healthy. Writing never fails the run: a lost
 * rejection costs one more try of that target.
 */
export class Rejections extends Context.Service<
  Rejections,
  {
    /** None when nothing failed, or the file does not read. */
    readonly read: Effect.Effect<Option.Option<Rejected>>
    readonly write: (rejected: Rejected) => Effect.Effect<void>
  }
>()("dotfiles-opencode/update/Rejections") {}

/** The update's own log: one line per step, never a notification. */
export class Log extends Context.Service<
  Log,
  {
    readonly line: (text: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/update/Log") {}

/** The background service, as the handoff restarts and reads it from outside. */
export class Service extends Context.Service<
  Service,
  {
    /** Restarts the service onto the installed build, and loads its resident location. */
    readonly restart: Effect.Effect<void, UpdateFailed>
    /** What the running service says of its plugins and its pool. */
    readonly read: Effect.Effect<Reading, UpdateFailed>
  }
>()("dotfiles-opencode/update/Service") {}

/**
 * The server config a staged build wrote, and the one it replaced: a rollback puts the replaced
 * one back with the build it belongs to.
 */
export class Configs extends Context.Service<
  Configs,
  {
    /** Keeps the config the running build runs with, before a stage writes the next one. */
    readonly keep: Effect.Effect<void, UpdateFailed>
    /** Puts the kept config back. */
    readonly restore: Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Configs") {}

/**
 * What the owner sees of a failed update without the plugin that failed: a line in the TUI's
 * corner, which no server plugin draws.
 */
export class Notice extends Context.Service<
  Notice,
  {
    readonly show: (text: string) => Effect.Effect<void>
    readonly clear: Effect.Effect<void>
  }
>()("dotfiles-opencode/update/Notice") {}

import { Context, type Effect, type Option, Schema } from "effect"
import type { Reading } from "./health.ts"
import type { Placement } from "./placement.ts"
import type { Record } from "./record.ts"
import type { Target } from "./target.ts"
import type { Rejected, Running } from "./update.ts"

/** A step of an update failed: which, and what its command said. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

/**
 * The checkout could not move to the target (git refused: an untracked file the target tracks with
 * other content, a diverged branch): nothing moved, so nothing is installed or rejected, and the
 * next check tries again. Measured 2026-11-15: the Mac kept batch ck for hours because an untracked
 * copy of a file the target had just added made git refuse, and the refusal was a rejection.
 */
export class CheckoutStuck extends Schema.TaggedError<CheckoutStuck>()("CheckoutStuck", {
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
     * Moves the checkout to `commit` and installs its dependencies as its lockfile pins them, then the
     * host's commands into `~/.local/bin` (`git/source.ts` `binScript`). A failed install moves
     * the checkout back to where it was, so no plugin ever loads from a tree whose dependencies are
     * missing. An untracked file the commit tracks with the same content is the commit's own file
     * and goes first; when git still refuses the move, the failure is `CheckoutStuck`.
     */
    readonly advance: (commit: string) => Effect.Effect<void, UpdateFailed | CheckoutStuck>
    /** Installs the checkout's dependencies again, as it stands. */
    readonly reinstall: Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Source") {}

/**
 * The two halves of an install, split so the live checkout moves only at the restart: the server
 * and every TUI hot-reload a local plugin when its files change, so a checkout moved ahead of the
 * build ran the new plugins on the old fork until the restart (2026-11-19: Prime's `ui.Spinner` on
 * a fork without it, for 7 minutes).
 */
export class Builder extends Context.Service<
  Builder,
  {
    /**
     * Builds the target ahead of the restart from the checkout as it stands, which does not move
     * (`bun scripts/daily.ts --stage`): the fork at the target's commit, the binary, and the
     * installed record naming the target's commits. It writes no config and restarts nothing.
     */
    readonly stage: (target: Target) => Effect.Effect<void, UpdateFailed>
    /**
     * Writes the server and TUI configs from the checkout's own install code (`bun
     * scripts/daily.ts --configure`), once the handoff moved it onto the build's commit.
     */
    readonly configure: Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Builder") {}

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

/** A build file a prune deleted, and how many bytes it held. */
export interface Pruned {
  readonly name: string
  readonly bytes: number
}

/**
 * The builds in the share directory (`~/.local/share/opencode-prime`, `opencode-<version>`), each
 * about 225 MB. A prune deletes the ones `builds.ts` `prunable` names: none of the record's builds
 * a TUI or a rollback needs, none a process runs, none changed lately, and nothing when the running
 * executables do not read. It holds the builds lock (`settings.ts` `buildsLock`) that daily's stage
 * holds too, so the record it reads names every build in the directory it lists.
 */
export class Builds extends Context.Service<
  Builds,
  {
    /**
     * Under the builds lock, reads the record with `read` and deletes the builds it no longer needs,
     * answering each; with no record, none. Fails, deleting none, when the lock stays held or what
     * runs does not read.
     */
    readonly prune: (read: Effect.Effect<Option.Option<Record>>) => Effect.Effect<ReadonlyArray<Pruned>, UpdateFailed>
  }
>()("dotfiles-opencode/update/Builds") {}

/** The installed record (`record.ts`); a write points the launcher at the build it installs (`filestore/launcher.ts`). */
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

/**
 * When the updater last ran a check: a stamp in the update's own directory, which every copy of
 * the plugin reads. A stamp that does not write or read is none: the watchdog then counts from
 * its own start.
 */
export class Heartbeat extends Context.Service<
  Heartbeat,
  {
    /** Stamps a check, now. */
    readonly beat: Effect.Effect<void>
    /** The last check's stamp (epoch ms); none before the first. */
    readonly last: Effect.Effect<Option.Option<number>>
  }
>()("dotfiles-opencode/update/Heartbeat") {}

/**
 * The service's resident location, the one whose copy of the plugin updates. A service a TUI
 * started (its `service ensure`) loads only the TUI's location; `load` asks it for the resident
 * location too, as the launcher does after `service start`.
 */
export class Resident extends Context.Service<
  Resident,
  {
    readonly load: Effect.Effect<void, UpdateFailed>
  }
>()("dotfiles-opencode/update/Resident") {}

/** Where the service process runs (`placement.ts`), as the plugin inside it places and reads it. */
export class Placer extends Context.Service<
  Placer,
  {
    /** Asks the user manager for the service's own scope unless it runs there already; answers where it runs then. */
    readonly place: Effect.Effect<Placement>
    /** Where the service runs now. */
    readonly observe: Effect.Effect<Placement>
  }
>()("dotfiles-opencode/update/Placer") {}

/** The background service, as the handoff restarts and reads it from outside. */
export class Service extends Context.Service<
  Service,
  {
    /** Restarts the service onto the installed build, and loads its resident location. */
    readonly restart: Effect.Effect<void, UpdateFailed>
    /** What the running service says of its plugins, its pool and its logins. */
    readonly read: Effect.Effect<Reading, UpdateFailed>
    /**
     * The providers the running service has a usable login for (`Reading.logins`), read before the
     * restart, so the health after it can tell a lost login from one the host never had.
     */
    readonly logins: Effect.Effect<ReadonlyArray<string>, UpdateFailed>
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

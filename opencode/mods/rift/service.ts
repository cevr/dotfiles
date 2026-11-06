// The contracts the rift tool needs from outside: Rift itself (the `rift`
// CLI on the Mac, `workrift` around it on the workbox) with Git, the Git
// steps of a land and the repository's checks, the workbox's own scripts,
// the directory each session runs in and the notices that wake one. Each states its failure; `laws.ts` states
// what every implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { LandConfig, Merged, Ran, Started, Unit } from "./land.ts"
import type { Workspace } from "./workspace.ts"

/** A Rift or Git command failed; `message` is what it said. */
export class RiftFailed extends Schema.TaggedError<RiftFailed>()("RiftFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** The host could not say where a session runs. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** What a new Rift is made from and called. */
export interface CreateRequest {
  /** The warm source to copy, as `source` answers it. */
  readonly source: string
  /** The checkout asking for it, the session's directory: `workrift` carries its gh stack metadata over. */
  readonly from: string
  /** The Rift's directory name under `.rifts/<source>/`. */
  readonly name: string
  /** The branch to check out in it: the local branch, else the remote one, else a new one from the source's HEAD. */
  readonly branch: string
}

/** Rift workspaces and the Git checkouts inside them. */
export class Rifts extends Context.Service<
  Rifts,
  {
    /** The warm source `directory` belongs to: its Rift root. Fails when no Rift source holds it. */
    readonly source: (directory: string) => Effect.Effect<string, RiftFailed>
    /** A new Rift of the request's source, on its branch; answers its directory. */
    readonly create: (request: CreateRequest) => Effect.Effect<string, RiftFailed>
    /** The Rifts made directly from `source`. */
    readonly list: (source: string) => Effect.Effect<ReadonlyArray<string>, RiftFailed>
    /** What `path` holds. Fails when `path` is no Rift workspace. */
    readonly inspect: (path: string) => Effect.Effect<Workspace, RiftFailed>
    /** Moves the Rift at `path` to Rift's trash; with `withChildren`, its own Rifts go with it. */
    readonly remove: (path: string, options?: { readonly withChildren?: boolean }) => Effect.Effect<void, RiftFailed>
  }
>()("dotfiles-opencode/rift/Rifts") {}

/**
 * The Git steps of landing a batch of Rifts in an integration Rift, and the
 * repository's own checks run there.
 */
export class Landing extends Context.Service<
  Landing,
  {
    /** How the repository of the warm source `source` lands. */
    readonly config: (source: string) => Effect.Effect<LandConfig, RiftFailed>
    /** The Rift's uncommitted changes (`git status --porcelain` lines, untracked files one by one) whose file differs from the same file in its warm source. */
    readonly ownChanges: (path: string, source: string) => Effect.Effect<ReadonlyArray<string>, RiftFailed>
    /**
     * Puts the integration Rift at origin's newest `<main>`, on its own branch:
     * repairs a stale multi-pack index, aborts a merge left in progress,
     * fetches origin and checks the branch out there afresh, dropping any
     * tracked change a gate left (the integration Rift holds no one's work).
     */
    readonly start: (integration: string, main: string) => Effect.Effect<Started, RiftFailed>
    /**
     * Merges the branch of the Rift at `from` into the integration Rift. A
     * conflict in lock files and `config.generated` files alone is settled:
     * the Rift's side, installed again and `config.regenerate` run, then
     * committed. Any other conflict aborts the merge and answers its files.
     */
    readonly merge: (integration: string, from: Unit, config: LandConfig) => Effect.Effect<Merged, RiftFailed>
    /** Installs each lock file changed since `previous`, and commits each one the install rewrote; answers those. */
    readonly install: (integration: string, previous: string) => Effect.Effect<ReadonlyArray<string>, RiftFailed>
    /**
     * Runs `config.regenerate` at the integration Rift's root after the
     * merges and the install, since a clean merge can leave a generated file
     * stale, and commits what it changed among `config.generated` and the
     * lock files as one commit; answers those files, none when nothing
     * changed. A failing command fails, before the gate.
     */
    readonly regenerate: (integration: string, config: LandConfig) => Effect.Effect<ReadonlyArray<string>, RiftFailed>
    /** Runs the repository's `command` (a shell line) in `path`, keeping its output in a log; never fails on its exit code. */
    readonly check: (path: string, label: "gate" | "accept", command: string, env: Readonly<Record<string, string>>) => Effect.Effect<Ran, RiftFailed>
    /** Pushes HEAD to `<main>` on origin when it holds origin's newest `<main>`; answers the pushed commit, `<hash> <subject>`. */
    readonly push: (path: string, main: string) => Effect.Effect<string, RiftFailed>
    /** Pushes the Rift at `unit.path`'s branch to the same branch on origin, never forced; answers the pushed commit, `<hash> <subject>`. */
    readonly pushBranch: (unit: Unit) => Effect.Effect<string, RiftFailed>
    /** Fetches origin in a landed Rift, so its commits read as pushed. */
    readonly sync: (path: string) => Effect.Effect<void, RiftFailed>
  }
>()("dotfiles-opencode/rift/Landing") {}

/** A message to a session, read at its next step; an idle session wakes for it. */
export interface Notice {
  readonly text: string
  /** The one line the transcript shows for it. */
  readonly description: string
}

/** Notices to the server's sessions. */
export class Notices extends Context.Service<
  Notices,
  {
    /** Puts `notice` into the session and wakes it; a session that cannot take it is logged and skipped. */
    readonly wake: (sessionID: string, notice: Notice) => Effect.Effect<void>
  }
>()("dotfiles-opencode/rift/Notices") {}

/** A `workrift` command the tool runs as is, or the workbox's storage check. */
export type WorkboxCommand =
  | { readonly _tag: "init"; readonly repository: string; readonly path?: string | undefined }
  | { readonly _tag: "refresh" | "deps" | "check" | "sources" | "prune" | "storage" }

/** The command needs the workbox's `workrift`, which this host lacks. */
export class NotOnWorkbox extends Schema.TaggedError<NotOnWorkbox>()("NotOnWorkbox", { command: Schema.String }) {}

/** The workbox's own Rift scripts: `workrift` and `workbox-rift-storage`. */
export class Workbox extends Context.Service<
  Workbox,
  {
    /**
     * Runs `command` from `cwd`, with WORKRIFT_SOURCE set to `source` when given;
     * answers what it printed. `prune` only ever lists (`--dry-run`); `storage`
     * is `workbox-rift-storage --check` and the file system's use.
     */
    readonly run: (command: WorkboxCommand, cwd: string, source?: string) => Effect.Effect<string, RiftFailed | NotOnWorkbox>
  }
>()("dotfiles-opencode/rift/Workbox") {}

/** Where each session's tools run. */
export class SessionDirectories extends Context.Service<
  SessionDirectories,
  {
    /** The session's directory, absolute. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string, SessionUnreadable>
  }
>()("dotfiles-opencode/rift/SessionDirectories") {}

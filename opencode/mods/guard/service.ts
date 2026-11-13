// The contracts the guard needs from outside: whether a path is a
// repository's root, the directory a session's shell runs in, whether a
// session is a subagent, the processes running on the machine, a checkout's
// file system and origin with Rift's warm sources, and where
// launchers live and whether systemd scopes work. Each states its failure;
// `laws.ts` states what every implementation owes.
import { Context, type Effect, type Option, Schema } from "effect"
import type { ProcessInfo } from "./kill.ts"

/** The guard could not tell whether `path` is a repository's root. */
export class RepoRootUnknown extends Schema.TaggedError<RepoRootUnknown>()("RepoRootUnknown", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** The host could not say where a session runs. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The guard could not list the machine's processes. */
export class ProcessesUnreadable extends Schema.TaggedError<ProcessesUnreadable>()("ProcessesUnreadable", {
  message: Schema.String,
}) {}

/** Repositories on disk, as far as the guard asks about them. */
export class RepoRoots extends Context.Service<
  RepoRoots,
  {
    /** Whether `path` (absolute) holds a `.git` entry, a directory or a worktree's file. A missing path is not a root. */
    readonly isRoot: (path: string) => Effect.Effect<boolean, RepoRootUnknown>
  }
>()("dotfiles-opencode/guard/RepoRoots") {}

/** Which sessions are subagents: a session another session started, as OpenCode records it by its parent. */
export class Subagents extends Context.Service<
  Subagents,
  {
    /** Whether the session has a parent session. */
    readonly isSubagent: (sessionID: string) => Effect.Effect<boolean, SessionUnreadable>
  }
>()("dotfiles-opencode/guard/Subagents") {}

/** Where each session's tools run. */
export class SessionDirectories extends Context.Service<
  SessionDirectories,
  {
    /** The session's directory, absolute: where a shell call with no `workdir` runs. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string, SessionUnreadable>
  }
>()("dotfiles-opencode/guard/SessionDirectories") {}

/** A launcher could not be written. */
export class LauncherUnavailable extends Schema.TaggedError<LauncherUnavailable>()("LauncherUnavailable", {
  message: Schema.String,
}) {}

/** Where launchers (launcher.ts) live on disk. */
export class Launchers extends Context.Service<
  Launchers,
  {
    /** The absolute path of an executable file named `name` holding `script`, written when no such file exists yet. Two scripts never share a path. */
    readonly install: (name: string, script: string) => Effect.Effect<string, LauncherUnavailable>
  }
>()("dotfiles-opencode/guard/Launchers") {}

/** Whether this machine can run a command in a systemd user scope, and in the idle I/O class. */
export class Scopes extends Context.Service<
  Scopes,
  {
    /** True when `systemd-run --user --scope` works here; asked once, then known. */
    readonly available: Effect.Effect<boolean>
    /** True when `ionice -c3` can run a command here (Linux, with `ionice` on PATH). */
    readonly ionice: Effect.Effect<boolean>
  }
>()("dotfiles-opencode/guard/Scopes") {}

/** The guard could not read a checkout, or the warm sources Rift copies from. */
export class CheckoutUnknown extends Schema.TaggedError<CheckoutUnknown>()("CheckoutUnknown", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A Git checkout as the worktree rule (worktree.ts) reads it. */
export interface Checkout {
  /** Its top directory, absolute. */
  readonly root: string
  /** The type of the file system it sits on, as `mount` names it (`apfs`, `btrfs`, `ext4`). */
  readonly filesystem: string
  /** Its `origin` remote's URL; none when it has no origin. */
  readonly origin: Option.Option<string>
}

/** A warm source Rift copies from: its directory and its `origin` remote's URL. */
export interface WarmSource {
  readonly path: string
  readonly origin: Option.Option<string>
}

/** Git checkouts and Rift's warm sources on this machine, read when a call makes a git worktree. */
export class Checkouts extends Context.Service<
  Checkouts,
  {
    /** The checkout `directory` (absolute) is in; none when no Git checkout holds it, or it does not exist. */
    readonly of: (directory: string) => Effect.Effect<Option.Option<Checkout>, CheckoutUnknown>
    /** The warm sources Rift copies from on this machine (`workrift sources`); none where no such list is kept. */
    readonly warmSources: Effect.Effect<ReadonlyArray<WarmSource>, CheckoutUnknown>
  }
>()("dotfiles-opencode/guard/Checkouts") {}

/** The processes running on the machine, read when a call kills by pattern. */
export class Processes extends Context.Service<
  Processes,
  {
    /** Every process the user can see, each with its name and its full command line, as `ps -A` lists them now. */
    readonly list: () => Effect.Effect<ReadonlyArray<ProcessInfo>, ProcessesUnreadable>
  }
>()("dotfiles-opencode/guard/Processes") {}

// The contracts the guard needs from outside: whether a path is a
// repository's root, the directory a session's shell runs in, and the
// processes running on the machine. Each states its failure; `laws.ts` states
// what every implementation owes.
import { Context, type Effect, Schema } from "effect"
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

/** Whether this machine can run a command in a systemd user scope. */
export class Scopes extends Context.Service<
  Scopes,
  {
    /** True when `systemd-run --user --scope` works here; asked once, then known. */
    readonly available: Effect.Effect<boolean>
  }
>()("dotfiles-opencode/guard/Scopes") {}

/** The processes running on the machine, read when a call kills by pattern. */
export class Processes extends Context.Service<
  Processes,
  {
    /** Every process the user can see, each with its name and its full command line, as `ps -A` lists them now. */
    readonly list: () => Effect.Effect<ReadonlyArray<ProcessInfo>, ProcessesUnreadable>
  }
>()("dotfiles-opencode/guard/Processes") {}

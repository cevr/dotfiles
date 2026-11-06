// The contracts the guard needs from outside: whether a path is a
// repository's root, the directory a session's shell runs in, and whether a
// session is a subagent. Each states
// its failure; `laws.ts` states what every implementation owes.
import { Context, type Effect, Schema } from "effect"

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

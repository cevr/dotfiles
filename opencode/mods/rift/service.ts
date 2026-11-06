// The contracts the rift tool needs from outside: Rift itself (the `rift`
// CLI on the Mac, `workrift` around it on the workbox) with Git, and the
// directory each session runs in. Each states its failure; `laws.ts` states
// what every implementation owes.
import { Context, type Effect, Schema } from "effect"
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
    /** Moves the Rift at `path` to Rift's trash. */
    readonly remove: (path: string) => Effect.Effect<void, RiftFailed>
  }
>()("dotfiles-opencode/rift/Rifts") {}

/** Where each session's tools run. */
export class SessionDirectories extends Context.Service<
  SessionDirectories,
  {
    /** The session's directory, absolute. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string, SessionUnreadable>
  }
>()("dotfiles-opencode/rift/SessionDirectories") {}

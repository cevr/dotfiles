// The contracts the git model needs from outside, with their failures: where
// a session runs, the checkout holding a directory, the branch's pull request
// and whether a program is on PATH. What every implementation owes is in
// laws.ts.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Checkout } from "./checkout.ts"
import type { PullRequest } from "./pull-request.ts"

/** The host could not say where a session runs. */
export class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** Where each session runs. */
export class SessionDirectories extends Context.Service<
  SessionDirectories,
  {
    /** The session's directory, absolute: its location now, which moves when the session does. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string, SessionUnreadable>
  }
>()("dotfiles-opencode/git/SessionDirectories") {}

/** git ran in a checkout and did not answer: it failed or timed out. */
export class CheckoutUnreadable extends Schema.TaggedError<CheckoutUnreadable>()("CheckoutUnreadable", {
  message: Schema.String,
}) {}

/** Checkouts on disk, read without writing: no index refresh, no lock, no hook. */
export class Checkouts extends Context.Service<
  Checkouts,
  {
    /**
     * The checkout holding `directory`, its changes counted against its base,
     * untracked files included. None outside a checkout, for a directory that
     * is gone, and with no git on PATH.
     */
    readonly read: (directory: string) => Effect.Effect<Option.Option<Checkout>, CheckoutUnreadable>
  }
>()("dotfiles-opencode/git/Checkouts") {}

/** `gh` is not on PATH: there is no pull request to ask for. */
export class GhMissing extends Schema.TaggedError<GhMissing>()("GhMissing", {}) {}

/** `gh` ran and did not answer: signed out, a failure, a timeout or an answer that does not decode. */
export class PullRequestUnreadable extends Schema.TaggedError<PullRequestUnreadable>()("PullRequestUnreadable", {
  message: Schema.String,
}) {}

/** Pull requests, as `gh` names them. */
export class PullRequests extends Context.Service<
  PullRequests,
  {
    /** The request of the branch checked out at `root`. None when it has none or the checkout has no GitHub remote. */
    readonly read: (root: string) => Effect.Effect<Option.Option<PullRequest>, GhMissing | PullRequestUnreadable>
  }
>()("dotfiles-opencode/git/PullRequests") {}

/** The programs on PATH. */
export class Programs extends Context.Service<
  Programs,
  {
    /** Whether a program by `name` is on PATH. */
    readonly found: (name: string) => Effect.Effect<boolean>
  }
>()("dotfiles-opencode/git/Programs") {}

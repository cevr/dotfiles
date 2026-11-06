// The contracts the git model needs from outside, with their failures: where
// a session runs, the checkout holding a directory, the branch's pull request
// and whether a program is on PATH; for the `pr` tool and its watcher, GitHub,
// the watch store and the courier that puts a notice into a session. What
// every implementation owes is in laws.ts.
import { Context, type Effect, type Option, Schema } from "effect"
import type { BranchRead, RepoRecord } from "./branch.ts"
import type { Checkout } from "./checkout.ts"
import type { PullRequest } from "./pull-request.ts"
import type { Report } from "./report.ts"
import type { PrRef, Watch } from "./watch.ts"

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

// ── The pr tool and the watcher ──

/** `gh` ran and GitHub did not answer: signed out, refused, failed, timed out or answered what does not decode. */
export class GitHubUnreadable extends Schema.TaggedError<GitHubUnreadable>()("GitHubUnreadable", {
  message: Schema.String,
}) {}

/** One read of a repository: the requests asked for that exist, the numbers that do not, and its default branch. */
export interface RepoRead {
  readonly reports: ReadonlyArray<Report>
  readonly missing: ReadonlyArray<number>
  readonly branch: BranchRead
}

/** Where a directory stands on GitHub: its checkout's repository and its branch's request, each when it has one. */
export interface Here {
  readonly repo?: string
  readonly number?: number
}

/** What a new request is opened with. */
export interface Opening {
  readonly title: string
  readonly body: string
  readonly base?: string
  readonly draft: boolean
  readonly reviewers: ReadonlyArray<string>
}

/** GitHub, as `gh` reaches it. */
export class GitHub extends Context.Service<
  GitHub,
  {
    /** The repository of the checkout at `directory` and its branch's open request. */
    readonly here: (directory: string) => Effect.Effect<Here, GhMissing | GitHubUnreadable>
    /** The requests `numbers` of `repo` and its default branch, in one read. */
    readonly read: (repo: string, numbers: ReadonlyArray<number>) => Effect.Effect<RepoRead, GhMissing | GitHubUnreadable>
    /**
     * Whether any of the REST `paths` answers differently from the last time
     * this server asked it; a path never asked counts as changed. A path that
     * did not change costs no rate limit (a conditional request).
     */
    readonly changed: (paths: ReadonlyArray<string>) => Effect.Effect<boolean, GhMissing | GitHubUnreadable>
    /** The log of the Actions job `jobId` of `repo`. */
    readonly jobLog: (repo: string, jobId: number) => Effect.Effect<string, GhMissing | GitHubUnreadable>
    /** Opens a request for the branch checked out at `directory`; its URL. */
    readonly create: (directory: string, opening: Opening) => Effect.Effect<string, GhMissing | GitHubUnreadable>
  }
>()("dotfiles-opencode/git/GitHub") {}

/** The watches and the repositories the watcher follows, kept across restarts and shared by every directory's plugin. */
export class WatchStore extends Context.Service<
  WatchStore,
  {
    readonly watches: Effect.Effect<ReadonlyArray<Watch>>
    readonly put: (watch: Watch) => Effect.Effect<void>
    readonly remove: (sessionID: string, ref: PrRef) => Effect.Effect<void>
    readonly repos: Effect.Effect<ReadonlyArray<RepoRecord>>
    readonly putRepo: (record: RepoRecord) => Effect.Effect<void>
  }
>()("dotfiles-opencode/git/WatchStore") {}

/** The host refused a notice: no such session, or its inbox failed. */
export class NoticeRefused extends Schema.TaggedError<NoticeRefused>()("NoticeRefused", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** A notice: its one-line title (the `◈` row) and its text. */
export interface Notice {
  readonly title: string
  readonly text: string
}

/** The sessions notices go to. */
export class Courier extends Context.Service<
  Courier,
  {
    /** The root of `sessionID`'s family: itself when it has no parent. */
    readonly rootOf: (sessionID: string) => Effect.Effect<string, SessionUnreadable>
    /** Puts `notice` into the session as a steered message, waking it when idle. */
    readonly deliver: (sessionID: string, notice: Notice) => Effect.Effect<void, NoticeRefused>
  }
>()("dotfiles-opencode/git/Courier") {}

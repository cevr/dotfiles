// The `pr` tool's surface: its input, what it says it does, and how it names
// the requests and reviewers it is given. The handlers are in pulls.ts.
import { Schema } from "effect"
import { Until, type PrRef } from "./watch.ts"

export const Action = Schema.Literals(["status", "watch", "unwatch", "list", "create"])
export type Action = typeof Action.Type

/** A request: its number in the session's repository, `owner/name#123`, or its URL. */
export const Target = Schema.Union([Schema.Number, Schema.String])
export type Target = typeof Target.Type

export const PrInput = Schema.Struct({
  action: Action.annotate({ description: "status, watch, unwatch, list or create." }),
  prs: Schema.optional(Schema.Array(Target)).annotate({
    description:
      "The requests: a number in the session's repository, owner/name#123, or a URL. Default: the request of the session's branch. For unwatch, default: every watch of this session.",
  }),
  until: Schema.optional(Until).annotate({
    description: "watch: green (the checks pass; a failure is told and the watch goes on), reviewed (a review or a new decision), or changed (every change). Default green.",
  }),
  note: Schema.optional(Schema.String).annotate({ description: "watch: what to do when it fires, carried in the notice." }),
  title: Schema.optional(Schema.String).annotate({ description: "create: the title." }),
  body: Schema.optional(Schema.String).annotate({ description: "create: the body." }),
  base: Schema.optional(Schema.String).annotate({ description: "create: the base branch. Default the repository's default branch." }),
  draft: Schema.optional(Schema.Boolean).annotate({ description: "create: open it as a draft." }),
  reviewers: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Literals(["default", "none"])])).annotate({
    description: "create: logins to request review from; default (the default) asks the repository owner's configured reviewers, none asks no one.",
  }),
})
export type PrInput = typeof PrInput.Type

export const DESCRIPTION = [
  "GitHub pull requests and CI, without polling them by hand.",
  "- status: per request, the head commit, its checks grouped fail/pending/pass/cancelled (each failing job with its failing tests and a log excerpt), the review decision and latest reviews, unresolved threads, requested reviewers and mergeability. A cancelled run is not a failure.",
  "- watch: the server watches the requests for you and sends a notice into this session when what you wait for comes (until green, reviewed or changed), with what changed. Set it and end your turn or do other work; never poll with gh, sleep or a monitor.",
  "- unwatch, list: stop or list this session's watches.",
  "- create: opens a request for the session's branch (push it first) with title and body, asking the configured reviewers unless reviewers says otherwise.",
  "Once you used the tool on a repository, a notice also comes when its default branch turns red, and when it is green again.",
].join("\n")

/** The input names what the action cannot use, or lacks what it needs. */
export class BadInput extends Schema.TaggedError<BadInput>()("BadInput", { reason: Schema.String }) {}

const URL_FORM = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const REF_FORM = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const NUMBER_FORM = /^#?(\d+)$/

/**
 * The request `target` names: a URL or `owner/name#123` names its own
 * repository; a bare number is in `here`, the session's repository.
 */
export const refOf = (target: Target, here: string | undefined): PrRef | BadInput => {
  const text = String(target).trim()
  const named = URL_FORM.exec(text) ?? REF_FORM.exec(text)
  if (named !== null) return { repo: named[1] ?? "", number: Number(named[2]) }
  const bare = NUMBER_FORM.exec(text)
  if (bare === null) return new BadInput({ reason: `${text} names no pull request: give a number, owner/name#123 or a URL` })
  if (here === undefined) return new BadInput({ reason: `#${bare[1]} needs a repository: the session is in no GitHub checkout; give owner/name#${bare[1]}` })
  return { repo: here, number: Number(bare[1]) }
}

/** The repository named by a pull request's URL. */
export const repoOfUrl = (url: string): string | undefined => URL_FORM.exec(url)?.[1]

/** The reviewers a create asks: the given logins, none, or the owner's configured ones. */
export const reviewersFor = (repo: string, asked: PrInput["reviewers"], configured: Readonly<Record<string, ReadonlyArray<string>>>): ReadonlyArray<string> => {
  if (asked === "none") return []
  if (asked === undefined || asked === "default") return configured[repo] ?? configured[repo.split("/")[0] ?? ""] ?? []
  return asked
}

// The branch's pull request as `gh pr view --json` names it, and how the
// sidebar and the /git pane say it: `#123 Title · open · checks ✓ · review
// required`. `gh` is an optional program: none on PATH, a checkout with no
// GitHub remote, a branch with no request and a `gh` that is not signed in
// all show no request.
import { Schema } from "effect"

/**
 * One check of a pull request as `gh` names it: a check run has a `status`
 * and, once completed, a `conclusion`; a commit status has a `state`.
 */
export const PullRequestCheck = Schema.Struct({
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type PullRequestCheck = typeof PullRequestCheck.Type

/** The fields of `gh pr view --json` the sidebar and the pane read. */
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optionalKey(Schema.NullOr(Schema.Array(PullRequestCheck))),
})
export type PullRequest = typeof PullRequest.Type

/** The fields `gh pr view` is asked for. */
export const PULL_REQUEST_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"

/** `gh pr view`'s answer, decoded; none when it is not a pull request. */
export const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest))

/** What `gh` says on stderr when there is no request to name: none, not a failure. */
const NO_PULL_REQUEST = ["no pull requests found", "no git remotes found", "none of the git remotes configured for this repository"]

/**
 * What a `gh pr view` that exited non-zero means, from its stderr: no request
 * to name, `gh` signed out, or another failure in its first line.
 */
export const refusal = (stderr: string): { readonly _tag: "None" } | { readonly _tag: "SignedOut" } | { readonly _tag: "Failed"; readonly message: string } => {
  const said = stderr.toLowerCase()
  if (NO_PULL_REQUEST.some((phrase) => said.includes(phrase))) return { _tag: "None" }
  if (said.includes("gh auth login")) return { _tag: "SignedOut" }
  return { _tag: "Failed", message: `gh pr view: ${stderr.trim().split("\n")[0] ?? ""}` }
}

/** The note a signed-out `gh` leaves in the /git pane. */
export const SIGNED_OUT = "gh is not signed in · gh auth login"

const FAILED_CHECK = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
const PENDING_CHECK = new Set(["PENDING", "EXPECTED"])

export type ChecksVerdict = "none" | "pass" | "fail" | "pending"

/** Where a pull request's checks stand: any failure fails them, then any check still running. */
export const checksVerdict = (checks: ReadonlyArray<PullRequestCheck>): ChecksVerdict => {
  if (checks.length === 0) return "none"
  const word = (value: string | null | undefined) => value ?? ""
  if (checks.some((check) => FAILED_CHECK.has(word(check.conclusion)) || FAILED_CHECK.has(word(check.state)))) return "fail"
  const running = (check: PullRequestCheck) =>
    (word(check.status).length > 0 && word(check.status) !== "COMPLETED") || PENDING_CHECK.has(word(check.state))
  return checks.some(running) ? "pending" : "pass"
}

const CHECK_GLYPH: Record<ChecksVerdict, string> = { pass: "✓", fail: "✗", pending: "…", none: "" }

/** GitHub's `CHANGES_REQUESTED` as `changes requested`. */
const spoken = (word: string): string => word.toLowerCase().replaceAll("_", " ")

/** `open`, `draft`, `merged` or `closed`. */
export const stateWord = (pr: PullRequest): string => (pr.isDraft && pr.state === "OPEN" ? "draft" : spoken(pr.state))

/** `#123 Title · open · checks ✓ · review required`: the parts it has, in that order. */
export const pullRequestLine = (pr: PullRequest): string => {
  const glyph = CHECK_GLYPH[checksVerdict(pr.statusCheckRollup ?? [])]
  return [`#${pr.number} ${pr.title}`, stateWord(pr), glyph.length > 0 ? `checks ${glyph}` : "", spoken(pr.reviewDecision ?? "")]
    .filter((part) => part.length > 0)
    .join(" · ")
}

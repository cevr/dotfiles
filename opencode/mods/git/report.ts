// A pull request as the `pr` tool reports it: the head commit, the checks
// at that commit grouped pass, fail, pending and cancelled, the review
// decision and the latest review of each reviewer, the unresolved threads,
// the requested reviewers and whether it merges. The `process/` GitHub reads
// it from one GraphQL query for many requests; this file names what it holds
// and how the tool says it.
import { Schema } from "effect"

/** `owner/name`, as GitHub names a repository. */
export const RepoName = Schema.String
export type RepoName = typeof RepoName.Type

/** A repository and the branch it merges into by default. */
export const Repo = Schema.Struct({ name: RepoName, defaultBranch: Schema.String })
export type Repo = typeof Repo.Type

/** Where a check stands. `cancelled` is apart: a run cancelled by a newer one is not a failure. */
export const CheckState = Schema.Literals(["pass", "fail", "pending", "cancelled"])
export type CheckState = typeof CheckState.Type

/** One check at the head commit: a check run (a GitHub Actions job, with its job id) or a commit status. */
export const Check = Schema.Struct({
  name: Schema.String,
  state: CheckState,
  /** GitHub's word for it: the conclusion, the status while it runs, or the commit status's state. */
  word: Schema.String,
  workflow: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  /** The Actions job behind a check run, whose log can be read. */
  jobId: Schema.optionalKey(Schema.Number),
})
export type Check = typeof Check.Type

/** A reviewer's latest review. */
export const Review = Schema.Struct({ author: Schema.String, state: Schema.String, at: Schema.String })
export type Review = typeof Review.Type

/** An unresolved review thread: who opened it, where, and its first line. */
export const Thread = Schema.Struct({
  author: Schema.String,
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  firstLine: Schema.String,
  outdated: Schema.Boolean,
})
export type Thread = typeof Thread.Type

export const Report = Schema.Struct({
  repo: RepoName,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  /** OPEN, CLOSED or MERGED. */
  state: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.String,
  head: Schema.String,
  headRef: Schema.String,
  baseRef: Schema.String,
  checks: Schema.Array(Check),
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED; none when the base needs no review. */
  reviewDecision: Schema.optionalKey(Schema.String),
  reviews: Schema.Array(Review),
  threads: Schema.Array(Thread),
  requested: Schema.Array(Schema.String),
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: Schema.String,
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS or UNKNOWN. */
  mergeState: Schema.String,
})
export type Report = typeof Report.Type

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])

/**
 * A check's state from GitHub's words: a check run's `conclusion` once it
 * completed (else its `status`), a commit status's `state`.
 */
export const checkState = (word: string): CheckState => {
  if (FAILED.has(word)) return "fail"
  if (PASSED.has(word)) return "pass"
  if (word === "CANCELLED" || word === "STALE") return "cancelled"
  return "pending"
}

/** Each name once: a re-run's newest check (the last listed) stands for the name. */
export const latest = (checks: ReadonlyArray<Check>): ReadonlyArray<Check> => {
  const byName = new Map<string, Check>()
  for (const check of checks) byName.set(check.name, check)
  return [...byName.values()]
}

export interface Groups {
  readonly pass: ReadonlyArray<Check>
  readonly fail: ReadonlyArray<Check>
  readonly pending: ReadonlyArray<Check>
  readonly cancelled: ReadonlyArray<Check>
}

export const groups = (checks: ReadonlyArray<Check>): Groups => {
  const all = latest(checks)
  return {
    pass: all.filter((check) => check.state === "pass"),
    fail: all.filter((check) => check.state === "fail"),
    pending: all.filter((check) => check.state === "pending"),
    cancelled: all.filter((check) => check.state === "cancelled"),
  }
}

/** Where the checks stand: any failure fails them, then any still running; no checks is `none`. */
export type Verdict = "none" | "pass" | "fail" | "pending"

export const verdict = (checks: ReadonlyArray<Check>): Verdict => {
  const grouped = groups(checks)
  if (grouped.fail.length > 0) return "fail"
  if (grouped.pending.length > 0) return "pending"
  return grouped.pass.length > 0 ? "pass" : "none"
}

/** GitHub's `CHANGES_REQUESTED` as `changes requested`. */
export const spoken = (word: string): string => word.toLowerCase().replaceAll("_", " ")

/** `open`, `draft`, `merged` or `closed`. */
export const stateOf = (report: Report): string => (report.isDraft && report.state === "OPEN" ? "draft" : spoken(report.state))

export const short = (sha: string): string => sha.slice(0, 8)

/** The first line of a comment, at most 120 characters. */
export const firstLine = (text: string): string => {
  const line = text.trim().split("\n")[0]?.trim() ?? ""
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

const where = (thread: Thread): string =>
  thread.path === undefined ? "" : thread.line === undefined ? ` · ${thread.path}` : ` · ${thread.path}:${thread.line}`

/** One thread on one line: `alice · src/a.ts:12 · "first line"`, `(outdated)` when its code moved on. */
export const threadLine = (thread: Thread): string =>
  `${thread.author}${where(thread)} · "${thread.firstLine}"${thread.outdated ? " (outdated)" : ""}`

/** What a failing job's log says: the tests it names and an excerpt. */
export interface JobFailure {
  readonly check: string
  readonly tests: ReadonlyArray<string>
  readonly excerpt: ReadonlyArray<string>
  /** Why there is no log to read, when there is none. */
  readonly note?: string
}

const names = (checks: ReadonlyArray<Check>, most = 12): string => {
  const shown = checks.slice(0, most).map((check) => check.name)
  return checks.length > most ? `${shown.join(", ")}, +${checks.length - most} more` : shown.join(", ")
}

/**
 * Each failing check on its lines, `  ✗ name [workflow] · failure · url`, with
 * the tests and log excerpt `failures` read for it.
 */
export const failingLines = (checks: ReadonlyArray<Check>, failures: ReadonlyArray<JobFailure> = []): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const check of groups(checks).fail) {
    lines.push(`  ✗ ${check.name}${check.workflow === undefined ? "" : ` [${check.workflow}]`} · ${spoken(check.word)}${check.url === undefined ? "" : ` · ${check.url}`}`)
    const failure = failures.find((each) => each.check === check.name)
    if (failure === undefined) continue
    if (failure.tests.length > 0) lines.push(`    failing tests: ${failure.tests.join(" | ")}`)
    if (failure.note !== undefined) lines.push(`    log: ${failure.note}`)
    if (failure.excerpt.length > 0) {
      lines.push("    log excerpt:")
      for (const line of failure.excerpt) lines.push(`      ${line}`)
    }
  }
  return lines
}

/** How many failing jobs' logs one answer or notice reads at most. */
export const MOST_LOGS = 3

/** The failing checks whose logs an answer reads: those with an Actions job, at most MOST_LOGS. */
export const logsToRead = (checks: ReadonlyArray<Check>): ReadonlyArray<Check> =>
  groups(checks)
    .fail.filter((check) => check.jobId !== undefined)
    .slice(0, MOST_LOGS)

/**
 * The report as the tool answers it, one block per request: the head, the
 * checks at the head (each failing one with its tests and log excerpt from
 * `failures`), the review, the threads, the reviewers asked and mergeability.
 */
export const reportText = (report: Report, failures: ReadonlyArray<JobFailure> = []): string => {
  const grouped = groups(report.checks)
  const lines: Array<string> = [
    `${report.repo}#${report.number} ${report.title} · ${stateOf(report)} · ${report.headRef} → ${report.baseRef} · by ${report.author}`,
    report.url,
  ]
  const counts = [
    grouped.fail.length > 0 ? `${grouped.fail.length} fail` : "",
    grouped.pending.length > 0 ? `${grouped.pending.length} pending` : "",
    grouped.pass.length > 0 ? `${grouped.pass.length} pass` : "",
    grouped.cancelled.length > 0 ? `${grouped.cancelled.length} cancelled` : "",
  ].filter((part) => part.length > 0)
  lines.push(`checks at ${short(report.head)}: ${counts.length === 0 ? "none" : counts.join(" · ")} (${verdict(report.checks)})`)
  lines.push(...failingLines(report.checks, failures))
  if (grouped.pending.length > 0) lines.push(`  … pending: ${names(grouped.pending)}`)
  if (grouped.cancelled.length > 0) lines.push(`  ⊘ cancelled: ${names(grouped.cancelled)}`)
  const reviews = report.reviews.map((review) => `${review.author} ${spoken(review.state)}`)
  lines.push(
    `review: ${report.reviewDecision === undefined ? "not required" : spoken(report.reviewDecision)}${reviews.length > 0 ? ` · ${reviews.join(", ")}` : ""}`,
  )
  lines.push(`requested reviewers: ${report.requested.length === 0 ? "none" : report.requested.join(", ")}`)
  if (report.threads.length === 0) lines.push("unresolved threads: none")
  else {
    lines.push(`unresolved threads (${report.threads.length}):`)
    for (const thread of report.threads) lines.push(`  - ${threadLine(thread)}`)
  }
  lines.push(`mergeable: ${spoken(report.mergeable)} · merge state: ${spoken(report.mergeState)}`)
  return lines.join("\n")
}

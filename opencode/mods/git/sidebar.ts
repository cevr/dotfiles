// What the session sidebar's Git section draws, as text: the branch with its
// upstream and how far apart they are, the files changed with their line
// counts, and the branch's pull request. tui/sidebar.tsx reads the git RPC
// (git.ts) and draws these lines under a bold "Git".
import { aheadBehind, branchName, delta, plural, totals } from "./checkout.ts"
import type { CheckoutAnswer, PullRequestAnswer } from "./git.ts"
import { checksVerdict, type PullRequest, pullRequestLine } from "./pull-request.ts"

/** How a line reads: muted, plain, or in the success, warning or error colour. */
export type Tone = "muted" | "base" | "success" | "warning" | "error"

export interface Line {
  readonly text: string
  readonly tone: Tone
}

/** A request's colour: its checks' verdict while open, muted once merged or closed. */
export const pullRequestTone = (pr: PullRequest): Tone => {
  if (pr.state !== "OPEN") return "muted"
  switch (checksVerdict(pr.statusCheckRollup ?? [])) {
    case "fail":
      return "error"
    case "pending":
      return "warning"
    case "pass":
      return "success"
    case "none":
      return "base"
  }
}

/**
 * The Git section: `main · ↑2 ↓1 origin/main`, `3 files +40 −12` (or `no
 * changes`), then `#123 Title · open · checks ✓ · review required` when the
 * branch has a request. A checkout that could not be read is one muted note;
 * a directory in no checkout has no section.
 */
export const sidebarLines = (checkout: CheckoutAnswer, pullRequest: PullRequestAnswer): ReadonlyArray<Line> => {
  if (checkout.checkout === undefined) return checkout.error === undefined ? [] : [{ text: `git unreadable: ${checkout.error}`, tone: "muted" }]
  const { head, files } = checkout.checkout
  const apart = aheadBehind(head)
  const upstream = head.upstream === undefined ? "" : ` · ${apart.length > 0 ? `${apart} ` : ""}${head.upstream}`
  const branch: Line = { text: `${branchName(head) ?? "no branch"}${upstream}`, tone: "base" }
  const changes: Line =
    files.length === 0 ? { text: "no changes", tone: "muted" } : { text: `${plural(files.length, "file")} ${delta(totals(files))}`, tone: "muted" }
  const pr = pullRequest.pullRequest
  return [branch, changes, ...(pr === undefined ? [] : [{ text: pullRequestLine(pr), tone: pullRequestTone(pr) }])]
}

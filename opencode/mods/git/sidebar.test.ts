// What the sidebar's Git section draws: the branch and its upstream, the
// changed files with their totals, the pull request in its checks' colour,
// a muted note for a checkout that could not be read, and nothing outside one.
import { describe, expect, test } from "bun:test"
import type { Checkout } from "./checkout.ts"
import type { PullRequest } from "./pull-request.ts"
import { pullRequestTone, sidebarLines } from "./sidebar.ts"

const checkout: Checkout = {
  root: "/work/app",
  base: "HEAD",
  head: { branch: "feature", oid: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", upstream: "origin/main", ahead: 2, behind: 1 },
  files: [
    { path: "a.ts", status: "M", added: 30, deleted: 10 },
    { path: "b.ts", status: "A", added: 10, deleted: 0 },
    { path: "logo.png", status: "?" },
    { path: "c.ts", status: "D", added: 0, deleted: 2 },
  ],
}

const request: PullRequest = {
  number: 123,
  title: "Port the git sidebar",
  url: "https://github.com/cevr/dotfiles/pull/123",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
}

describe("sidebarLines", () => {
  test("branch · counts upstream, then files and totals, then the pull request", () => {
    expect(sidebarLines({ checkout }, { pullRequest: request })).toEqual([
      { text: "feature · ↑2 ↓1 origin/main", tone: "base" },
      { text: "4 files +40 −12", tone: "muted" },
      { text: "#123 Port the git sidebar · open · checks ✓ · review required", tone: "success" },
    ])
  })

  test("no pull request row without one; a note from gh shows nowhere in the sidebar", () => {
    expect(sidebarLines({ checkout }, {}).map((line) => line.text)).toEqual(["feature · ↑2 ↓1 origin/main", "4 files +40 −12"])
    expect(sidebarLines({ checkout }, { note: "gh is not signed in · gh auth login" })).toHaveLength(2)
  })

  test("an even branch shows only its upstream; no upstream shows the branch alone; a clean checkout says so", () => {
    const even = { ...checkout, head: { ...checkout.head, ahead: 0, behind: 0 }, files: [] }
    expect(sidebarLines({ checkout: even }, {}).map((line) => line.text)).toEqual(["feature · origin/main", "no changes"])
    const local = { ...checkout, head: { branch: "spike", ahead: 0, behind: 0 } }
    expect(sidebarLines({ checkout: local }, {})[0]).toEqual({ text: "spike", tone: "base" })
  })

  test("outside a checkout there is no section; an unreadable one is one muted note", () => {
    expect(sidebarLines({}, {})).toEqual([])
    expect(sidebarLines({ error: "git status timed out" }, {})).toEqual([{ text: "git unreadable: git status timed out", tone: "muted" }])
  })
})

describe("pullRequestTone", () => {
  test("an open request takes its checks' colour; merged or closed is muted", () => {
    expect(pullRequestTone({ ...request, statusCheckRollup: [{ state: "FAILURE" }] })).toBe("error")
    expect(pullRequestTone({ ...request, statusCheckRollup: [{ state: "PENDING" }] })).toBe("warning")
    expect(pullRequestTone({ ...request, statusCheckRollup: null })).toBe("base")
    expect(pullRequestTone({ ...request, state: "MERGED" })).toBe("muted")
  })
})

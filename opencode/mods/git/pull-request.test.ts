// How `gh pr view --json` reads as a pull request and how the sidebar and the
// pane say it, and what each refusal on `gh`'s stderr means.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { checksVerdict, decodePullRequest, type PullRequest, pullRequestLine, refusal, stateWord } from "./pull-request.ts"

const request: PullRequest = {
  number: 123,
  title: "Port the git sidebar",
  url: "https://github.com/cevr/dotfiles/pull/123",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
}

describe("decodePullRequest", () => {
  test("reads gh's answer, nulls included; anything else is none", () => {
    expect(decodePullRequest(JSON.stringify({ ...request, reviewDecision: null, statusCheckRollup: null }))).toEqual(
      Option.some({ ...request, reviewDecision: null, statusCheckRollup: null }),
    )
    expect(decodePullRequest("not json")).toEqual(Option.none())
    expect(decodePullRequest(JSON.stringify({ number: "123" }))).toEqual(Option.none())
  })
})

describe("refusal", () => {
  test("no request or no GitHub remote is none, a missing login is signed out, anything else fails with its first line", () => {
    expect(refusal('no pull requests found for branch "feature"\n')).toEqual({ _tag: "None" })
    expect(refusal("none of the git remotes configured for this repository point to a known GitHub host")).toEqual({ _tag: "None" })
    expect(refusal("To get started with GitHub CLI, please run:  gh auth login")).toEqual({ _tag: "SignedOut" })
    expect(refusal("HTTP 502: Bad Gateway\nmore")).toEqual({ _tag: "Failed", message: "gh pr view: HTTP 502: Bad Gateway" })
  })
})

describe("checksVerdict", () => {
  test("any failure fails, then anything running is pending, else they pass; no checks is none", () => {
    expect(checksVerdict([])).toBe("none")
    expect(checksVerdict([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("pass")
    expect(checksVerdict([{ status: "IN_PROGRESS", conclusion: null }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending")
    expect(checksVerdict([{ state: "PENDING" }])).toBe("pending")
    expect(checksVerdict([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "TIMED_OUT" }])).toBe("fail")
    expect(checksVerdict([{ state: "ERROR" }])).toBe("fail")
  })
})

describe("pullRequestLine", () => {
  test("number and title, state, checks and review, leaving out what it lacks", () => {
    expect(pullRequestLine(request)).toBe("#123 Port the git sidebar · open · checks ✓ · review required")
    expect(pullRequestLine({ ...request, statusCheckRollup: [{ state: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "#123 Port the git sidebar · open · checks ✗ · changes requested",
    )
    expect(pullRequestLine({ ...request, isDraft: true, statusCheckRollup: [], reviewDecision: null })).toBe("#123 Port the git sidebar · draft")
    expect(stateWord({ ...request, state: "MERGED", isDraft: true })).toBe("merged")
  })
})

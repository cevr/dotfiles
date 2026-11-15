// A verifier's findings, read from its report: the batch file names each unit's findings file.
import { expect, test } from "bun:test"
import { Option } from "effect"
import { closedIn, findingsIn, unitFindings } from "./findings.ts"

const files: Record<string, string> = {
  "/run/batch-2-findings.md": [
    "Verdict: CHANGES REQUIRED",
    "",
    "| Unit | Round | Verdict | Findings |",
    "| --- | --- | --- | --- |",
    "| auth | 1 | changes | auth/round-1-findings.md |",
    "| billing | 2 | accepted | [findings](../run/billing/round-2-findings.md) |",
    "| search | 1 | changes | `/run/search/round-1-findings.md` |",
  ].join("\n"),
  "/run/batch-3-findings.md": "Verdict: CHANGES REQUIRED\n| auth | 1 | changes | auth/round-1-findings.md |\n| gone | 1 | changes | gone/round-1-findings.md |\n",
  "/run/batch-4-findings.md": "Verdict: CHANGES REQUIRED\nauth must fix its cache.\n",
  "/run/auth/round-1-findings.md": [
    "Verdict: CHANGES REQUIRED",
    "## Check",
    "| M1 is not a finding here |",
    "## Blockers",
    "### B1 — the land drops a unit",
    "## Major",
    "### M1 — a cache per location",
    "- **M2** the bound",
    "## Unproven",
    "- M3 needs a device",
  ].join("\n"),
  "/run/billing/round-2-findings.md": "Verdict: ACCEPTED\n## Major\nNone.\n",
  "/run/search/round-1-findings.md": "changes\n## Major\nA rule broken, no id given.\n",
}
const read = (path: string) => files[path]

test("a batch report names each unit's findings file; only a `changes` unit's Blockers and Majors are findings", () => {
  expect(findingsIn("/run/batch-2-findings.md", read)).toEqual({ _tag: "Read", findings: ["auth/B1", "auth/M1", "auth/M2", "search"] })
})

test("a unit's own findings file is read alone", () => {
  expect(findingsIn("/run/auth/round-1-findings.md", read)).toEqual({ _tag: "Read", findings: ["auth/B1", "auth/M1", "auth/M2"] })
  expect(unitFindings("billing", files["/run/billing/round-2-findings.md"]!)).toEqual([])
})

// Round 1, M1: what does not read is never an empty set of findings.
test("a missing report, a missing unit findings file it names, and a batch file naming none are each unread, saying which", () => {
  expect(findingsIn("/run/missing.md", read)).toEqual({ _tag: "Unread", why: "the report /run/missing.md does not read" })
  expect(findingsIn("/run/batch-3-findings.md", read)).toEqual({ _tag: "Unread", why: "the unit findings file /run/gone/round-1-findings.md of /run/batch-3-findings.md does not read" })
  expect(findingsIn("/run/batch-4-findings.md", read)).toEqual({ _tag: "Unread", why: "the report /run/batch-4-findings.md names no unit's round-N-findings.md" })
})

// land-adopt: the Bite run's batch-287-findings.md, line 40, and the `closed by batch-<k>` mark.
test("a verdict file's closing lines mark findings closed: each <unit>/<id> and each bare id after one; a line that says not, or no closing words, closes none", () => {
  const batch = [
    "accepted",
    "- cancelled-close-split r1: its #21526 revert (1a1d0aeedc7) was undone by the owner; #21788 is CLOSED. Nothing of this unit is left; no finding.",
    "- batch-283 approved-heads/M1, M2 -> fixed in bullmq-producer-failfast r2, on master with #21639 (50d2f6862c9), accepted in batch-286: folded and closed.",
    "- pr-21583/B2 closed by batch-12.",
    "- auth/M4 is not folded and closed: its fix is red.",
    "- search/M1 -> folded into search-fix1.",
    "| billing | 2 | accepted | billing/round-2-findings.md |",
  ].join("\n")
  const unit = "Verdict: ACCEPTED\n## Major\nNone.\nbilling/M3, billing/B1 closed by batch-9 (its PR).\n"
  const marks = new Map([
    ["/run/batch-287-findings.md", batch],
    ["/run/billing/round-2-findings.md", unit],
  ])
  const marked = (path: string) => Option.fromUndefinedOr(marks.get(path))
  expect(closedIn("/run/batch-287-findings.md", marked)).toEqual(["approved-heads/M1", "approved-heads/M2", "pr-21583/B2", "billing/M3", "billing/B1"])
  expect(closedIn("/run/missing.md", marked)).toEqual([])
  expect(closedIn("/run/batch-2-findings.md", (path) => Option.fromUndefinedOr(read(path)))).toEqual([])
})

// A verifier's findings, read from its report: the batch file names each unit's findings file.
import { expect, test } from "bun:test"
import { findingsIn, unitFindings } from "./findings.ts"

const files: Record<string, string> = {
  "/run/batch-2-findings.md": [
    "Verdict: CHANGES REQUIRED",
    "",
    "| Unit | Round | Verdict | Findings |",
    "| --- | --- | --- | --- |",
    "| auth | 1 | changes | auth/round-1-findings.md |",
    "| billing | 2 | accepted | [findings](../run/billing/round-2-findings.md) |",
    "| search | 1 | changes | `/run/search/round-1-findings.md` |",
    "| gone | 1 | changes | gone/round-1-findings.md |",
  ].join("\n"),
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
  expect(findingsIn("/run/batch-2-findings.md", read)).toEqual(["auth/B1", "auth/M1", "auth/M2", "search"])
})

test("a unit's own findings file is read alone; a report that cannot be read has none to say", () => {
  expect(findingsIn("/run/auth/round-1-findings.md", read)).toEqual(["auth/B1", "auth/M1", "auth/M2"])
  expect(findingsIn("/run/missing.md", read)).toBeUndefined()
  expect(unitFindings("billing", files["/run/billing/round-2-findings.md"]!)).toEqual([])
})

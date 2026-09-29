---
name: code-review
description: >
  Review a change yourself for correctness, minimality, slop, and test value, then
  optionally clean it up. Use for "review", "deslop", "clean up", "look over", stack
  checkpoints, API design review, performance review, or a test audit. For a second
  model family's review, use counsel-review, which runs these same criteria.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

# Code Review

A grounded same-model review against one set of criteria, validated against the source. Cleanup happens only when the user asked for it. `counsel-review` sends the same review to the other model family.

## Navigation

```
What was asked?
├─ Review, report only               → Phases 1–4
├─ Review and fix ("deslop", "clean up") → Phases 1–6
├─ Test audit                        → mode `tests`, references/test-audit.md
└─ Second model family's opinion     → counsel-review skill
```

| Reference | When to read |
| --- | --- |
| [references/review-contract.md](references/review-contract.md) | Always. The criteria for correctness, minimality, each slop class, performance evidence, and the finding test |
| [references/test-audit.md](references/test-audit.md) | The change adds or changes tests, or mode is `tests` |

## Phase 1: Scope and mode

Scope, in priority order:

1. User-specified files, directories, PR, or branch.
2. Branch diff: `git diff --name-only main...HEAD`.
3. Staged, then working-tree changes.
4. "Review the codebase": ask to narrow to one owner module first.

Mode:

| Mode | Use for |
| --- | --- |
| `diff` | A branch, pull request, or uncommitted change |
| `stack` | Dependent branches; review each checkpoint from its base |
| `design` | A public API or architecture decision |
| `performance` | A performance change; requires matched before-and-after evidence |
| `tests` | Existing tests in one owner module: low-value, duplicate, or implementation-coupled tests and the test-only seams they keep alive |

Outcome is **report** (read-only; edit nothing) unless the user asked for fixes.

## Phase 2: Load context

- The repo's `AGENTS.md` and lint config. A rule that lint or typecheck already enforces is not a finding; run the gate.
- Effect code: the `effect` skill, its `references/ARCHITECTURE.md` braids table, and the installed Effect source. Do not rely on remembered APIs.
- React files: the `react` skill.
- An owned dependency (same workspace or under the user's control): read its source. Assign a repair to the lowest owner; do not approve a downstream workaround because it exists.
- External library usage that looks off: `okra repo fetch <owner/repo>`, then `okra repo path -q <owner/repo>` (see the `repo` skill).

## Phase 3: Your review

Read the exact diff and every changed file in full. Read call sites and owner modules. Reproduce or inspect the behavior when you can.

Apply the review contract to the changed scope. Apply the test-audit authoring gate to every new or changed test; in `tests` mode, hunt the junk patterns and collect candidate evidence for each deletion. Prefer a few high-confidence findings over a speculative list.

Each candidate must pass the contract's finding test. Keep the evidence: file, line, invariant, reachable case.

## Phase 4: Validate and report

Re-open every cited file and follow the control flow before you keep a finding. Drop a candidate the source does not support. Separate pre-existing issues from issues in the reviewed change. No finding quota; no expansion into unrelated cleanup.

Lead with the verdict, then group:

1. `Blockers`: correctness or contract failure that must stop merge or release.
2. `Major`: likely defect, ownership error, or costly slop.
3. `Minor`: local slop with a small, clear repair.
4. `Optional`: valid improvement outside the minimum correct change.
5. `Rejected findings`: candidates you dropped, and why, when the user will expect them.

Each accepted finding gives: severity, class, file and line, violated invariant, smallest correct repair, owner, and for a test deletion or move the full candidate evidence from the test audit. Also report the proof status (gate and tests run).

When there is no blocker, say so plainly. Optional cleanup is never a merge condition.

In **report** outcome, stop here.

## Phase 5: Fix

Order: delete → simplify → unify → rename.

- Fix what the review accepted; no drive-by refactors.
- Read what you delete; grep for usages before removing anything that looks dead.
- When a fix would change observable behavior and intent is unclear, ask before applying it.
- For a recurring pattern, add the lint rule or type that makes it fail.

## Phase 6: Verify

Run the full gate (typecheck, lint, tests). Fix failures caused by the cleanup; do not revert to green.

Report scope, findings by group, what was fixed, what was deferred, and the files that informed each conclusion.

---
name: code-review
description: >
  Review a change yourself for correctness, spec conformance, minimality, slop, and
  test value, then optionally clean it up. Use for "review", "deslop", "clean up",
  "look over", a PR someone requested your review on, stack checkpoints, API design
  review, performance review, or a test audit.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

# Code Review

A grounded review against one set of criteria, validated against the source. Cleanup happens only when the user asked for it.

## Navigation

```
What was asked?
├─ Review, report only               → Phases 1–4
├─ Review and fix ("deslop", "clean up") → Phases 1–6
├─ Test audit                        → mode `tests`, references/test-audit.md
└─ Someone else's PR, review requested → Requested review
```

| Reference | When to read |
| --- | --- |
| [references/review-contract.md](references/review-contract.md) | Always. The criteria for correctness, minimality, each slop class, performance evidence, and the finding test |
| [references/test-audit.md](references/test-audit.md) | The change adds or changes tests, or mode is `tests` |
| [references/blast-radius.md](references/blast-radius.md) | A small diff you do not trust, or "what could this break": prove the one fact it is safe because of |
| [references/interrogate.md](references/interrogate.md) | A defect would be costly: adversary subagents try to break the change, and only findings a run proves survive |

## Phase 1: Scope and mode

Scope, in priority order:

1. User-specified files, directories, PR, or branch.
2. Branch diff: `git diff --name-only main...HEAD`.
3. Staged, then working-tree changes.
4. "Review the codebase": ask to narrow to one owner module first.

Pin the fixed point before anything else: resolve base and head with `git rev-parse --verify`, and read the diff. A ref that does not resolve, or an empty diff, ends the review with that one line.

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

- **The spec.** Discover it in this order: issue refs in the commit messages or branch name (fetch them from the tracker `AGENTS.md` names); a spec path the user passed; a file under `docs/`, `specs/` or `.scratch/` matching the branch or feature name. Found none: skip the Spec axis and say so in the report.
- The repo's `AGENTS.md` and lint config. A rule that lint or typecheck already enforces is not a finding; run the gate.
- Effect code: the `effect` skill, its `references/ARCHITECTURE.md` braids table, and the installed Effect source. Do not rely on remembered APIs.
- React files: the `react` skill.
- An owned dependency (same workspace or under the user's control): read its source. Assign a repair to the lowest owner; do not approve a downstream workaround because it exists.
- External library usage that looks off: the installed source in `node_modules/<package>`. For upstream source, when `command -v okra` succeeds: `okra repo fetch <owner/repo>`, then `okra repo path -q <owner/repo>` (see the `repo` skill).

## Phase 3: Your review

Read the exact diff. Read a changed file in full where the diff alone does not show its contract: a new module, a changed signature, a rewritten flow. Read call sites and owner modules. Reproduce or inspect the behavior when you can.

Apply the review contract to the changed scope. Apply the test-audit authoring gate to every new or changed test; in `tests` mode, hunt the junk patterns and collect candidate evidence for each deletion. Prefer a few high-confidence findings over a speculative list.

Each candidate must pass the contract's finding test. Keep the evidence: file, line, invariant, reachable case.

**Spec axis.** With a spec, check the change against every requirement in it: missing or partial (a requirement the change does not meet), scope creep (code no requirement asks for), wrong implementation (built, but not as the spec says). Each finding quotes the spec line.

**Safety fact.** Name the one fact the change is safe because of ("every caller passes an already-decoded value"), and push it down the proof ladder: said → pointed at the line → walked the path → ran it → reproduced in the app. A fact that stops before *ran it* is `unproven`.

## Second review

As Phase 3 ends, start ONE background subagent from the other model family on the same review, so a different family's blind spots check yours.

- **OpenCode** (the `subagent` tool takes `model`): you on Claude → the newest OpenAI Sol; you on GPT → the newest Claude Opus. Look the id up with the models tool, never a pinned version: the plain model of the newest release (`gpt-<n>-sol`, `claude-opus-<n>`), not a `-fast`, `-pro` or `-ultrafast` sibling. Pass `<provider>/<id>#high` when that model lists a `high` variant; otherwise its default, and the report says so. Use `agent: "worker"` and a `description` starting `second review`.
- **Claude Code**: a Codex thread (`mcp__codex__start`, `model: "sol"`), or `okra counsel`. **Codex**: `okra counsel`, which sends to Claude. With neither, skip.
- **The prompt**: the pinned base and head shas, the scope, the mode, the spec path if any, and: "Read `~/.claude/skills/code-review/SKILL.md` and its review contract; run Phases 1–4 on exactly this base and head, outcome report; skip its Second review." It is **independent**: give it none of your findings, candidates or safety fact.
- **No wait**: its report arrives as a message. Don't poll; end the turn or go on with other work, and run Phase 4 when it lands.
- **Skip** on a trivial diff (docs, a rename, a few lines with no logic), or when the user asked for a quick review; the report's verdict line says `second review: skipped (<reason>)`.

## Phase 4: Validate and report

Re-open every cited file and follow the control flow before you keep a finding. Drop a candidate the source does not support. Separate pre-existing issues from issues in the reviewed change. No finding quota; no expansion into unrelated cleanup.

With a second review, validate its findings the same way as yours. A finding both sides raise gains confidence; a finding only one side raises stays only when the source supports it. Each kept finding names who found it: `you`, `second (<model>)`, or `both`; a dropped second-review finding goes to `Rejected findings` with the reason.

Lead with the verdict and the safety fact with its rung, then group:

1. `Blockers`: correctness or contract failure that must stop merge or release.
2. `Major`: likely defect, ownership error, or costly slop.
3. `Minor`: local slop with a small, clear repair.
4. `Optional`: valid improvement outside the minimum correct change.
5. `Rejected findings`: candidates you dropped, and why, when the user will expect them.

Then the `Spec` section beside these groups, unranked against them: missing or partial, scope creep, wrong implementation, each with its quoted spec line, or the line saying no spec was found.

Each accepted finding gives: severity, class, file and line, violated invariant, smallest correct repair, owner, and for a test deletion or move the full candidate evidence from the test audit. Also report the proof status (gate and tests run).

When there is no blocker, say so plainly. Optional cleanup is never a merge condition.

In **report** outcome, stop here.

## Requested review

A PR someone else wrote and asked you to review (`gh search prs --review-requested=@me --state open`, or a PR the user names).

- Run Phases 1–4 yourself, with the Second review, in this session, in report outcome, on `gh pr diff` and `gh pr view` against the PR's base.
- Be thorough on correctness: every Blocker, Major and Minor defect, with its evidence. Style preferences and Optional cleanup stay out of the review.
- Verdict: `approve with notes` when nothing blocks, `request changes` when a Blocker or Major stands.
- Draft the review: the verdict, a short body, and inline comments at file and line. Post it on the owner's go.

## Phase 5: Fix

Order: delete → simplify → unify → rename.

- Fix what the review accepted; no drive-by refactors.
- Read what you delete; grep for usages before removing anything that looks dead.
- When a fix would change observable behavior and intent is unclear, ask before applying it.
- For a recurring pattern, add the lint rule or type that makes it fail.

## Phase 6: Verify

Run the full gate (typecheck, lint, tests). Fix failures caused by the cleanup; do not revert to green.

Report scope, findings by group, what was fixed, what was deferred, and the files that informed each conclusion.

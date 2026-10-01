---
name: architecture-loop
description: Run architecture passes until one finds polish only — sweep against the project's NORTH_STAR.md and PRIOR_ARTS.md, review code and tests, apply in isolated workspaces, counsel, live-check.
disable-model-invocation: true
---

# Architecture loop

A **pass** is: coverage audit → read-only sweeps → triage into batches → per batch: apply in its own workspace, one counsel round, merge → live check. Passes repeat until the close rule holds. This is `improve-codebase-architecture` run autonomously: the same lens, no grilling, every finding applied or rejected with a receipt.

The project says what good is; this skill says how to loop:

- **`NORTH_STAR.md`** (repo root): north stars, tiebreaks, owner rules, project passes, live check, rejected candidates. Format: `~/.claude/skills/improve-codebase-architecture/NORTH-STAR-FORMAT.md`.
- **`PRIOR_ARTS.md`** (repo root): what to compare against, by pass, and the comparisons already settled. Format: `~/.claude/skills/improve-codebase-architecture/PRIOR-ARTS-FORMAT.md`.
- **The ledger**, `plans/architecture-loop-<date>.md`: the single source of truth for what is done, rejected, carried and open. Every sweep, apply and counsel prompt names it. Layout: [`ledger-template.md`](ledger-template.md).
- **Pass files** (briefs, reports, logs, counsel prompts) live in `~/.cache/architecture-loop/<repo>/pass<N>/`.

Call the Skill tool with "codebase-design" once at the start; its glossary is the vocabulary of every prompt.

**Autonomy.** Decide by the principles in `~/Developer/personal/dotfiles/principles/` and write "decided by <principle>" on the ledger row. Every finding is applied or rejected with a receipt; the loop asks nothing. Five things stay with the owner, written as owner questions on the ledger while the loop carries on with the rest: a persisted or wire format change that is not additive, a north-star conflict no tiebreak settles, a run that costs money beyond what the owner rules allow, publishing or deploying, and pushing (only when asked).

**Safety.** [`safety.md`](safety.md) is the one copy of the safety rules. Every prompt the loop writes starts by sending the agent to read it, and `NORTH_STAR.md`'s owner rules, in full before any action.

## Passes

| Pass           | Runs                                          | Agents                     | Method                                                    |
| -------------- | --------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| architecture   | every pass                                    | one per area               | [`prompts/sweep.md`](prompts/sweep.md)                    |
| review         | every pass                                    | one per workspace package  | [`review.md`](review.md): slop and test value             |
| guardrails     | every pass                                    | one                        | `prompts/sweep.md`, guardrail focus; [Guardrails](#guardrails) |
| prior art      | first pass, then while To survey has rows     | one per source             | step 3                                                    |
| project passes | every pass, one per row of `NORTH_STAR.md` → Passes | one each             | the row's method                                          |

An **area** is a set of directories that change together (a package, or a layer of a large one). Areas cover every unswept directory first.

## Steps

0. **Project files.** Read `NORTH_STAR.md` and `PRIOR_ARTS.md`. Direction in the user's prompt (north stars, prior arts, a new pass, an owner rule) goes into them now, dated. When either file is missing, draft it from its format, the user's prompt, `AGENTS.md`/`CLAUDE.md`, the README, `CONTEXT.md`, the ADRs and earlier ledgers, and commit it. Done when both files exist and carry this run's direction.

1. **Open the ledger.** Copy the section layout of the newest `plans/architecture-loop-*.md`, or [`ledger-template.md`](ledger-template.md) when none exists. Record the HEAD hash and the baseline: source lines and files per package, by a `git ls-files` pathspec of source extensions that excludes tests and fixtures. Write the command on the ledger so every pass counts the same way; use `':(glob)…'` pathspecs, since a plain `*` crosses `/`. Done when the ledger exists with a baseline.

2. **Coverage audit.** List every source directory with its file count (the baseline pathspec, `| xargs -n1 dirname | sort | uniq -c`). Mark each directory no earlier ledger or report names. Those go first. Done when every directory is marked swept-before or unswept.

3. **Prior art.** First pass, and any pass while `PRIOR_ARTS.md` → To survey has rows. One read-only agent per source to survey, reading only what Settled leaves open. Done when every new idea is a ledger row (adopt, or rejected with the north star it fails) and each answered question moved to Settled.

4. **Sweep.** Fill [`prompts/sweep.md`](prompts/sweep.md) into `<pass dir>/sweep-brief.md`, then launch every pass of the table above in one message: architecture areas, a review agent per package, the guardrails agent, and each project pass. Done when every area, package and pass has a report, including those with no findings, and the ledger has each project pass's row.

5. **Triage.** Group findings into batches by the files they touch. Every report's P3s and "not worth a pass" lines go to the batch that owns their file; that batch fixes each or rejects it with a reason. Write the pass section of the ledger: verdict, decisions, the triage table (batch, workspace, items), and the open `Carried` rows of the last pass, each in a batch or carried on. Done when every finding is in a batch or rejected with a receipt.

6. **Apply.** Each batch gets its own isolated workspace from main, as `AGENTS.md` says (a Rift from the warm source; `workrift create p<N>-<batch>` on the workbox; a git worktree on branch `p<N>-<batch>` where Rift cannot clone the repo). Setup a workspace needs beyond install (a build, a linked git-ignored file) is written in the project's `AGENTS.md`; a missing step found here goes there. Launch one apply agent per batch from [`prompts/apply.md`](prompts/apply.md). Batches with disjoint files run in parallel, about eight agents at most; a batch that needs another's files starts from main after that one merges. Done per batch when its tree is clean and its last commit passed the gate and the hook.

7. **Counsel.** One round per batch, from [`prompts/counsel.md`](prompts/counsel.md), through the `counsel-review` skill, or a fresh read-only agent when the other model is unreachable. The apply agent fixes each defect with a test that is red first, in one fixup round. Done when every defect has a commit or a written rejection.

8. **Merge.** In the workspace: merge main, resolve conflicts by keeping both sides' edits (never one side's file whole), run the gate into a log and read its exit line. Then from the main checkout: fetch the branch, `git merge --no-edit p<N>-<batch>`, gate into a log, read the exit line. Write the batch's ledger row (`done <hash> … <hash>, merged <hash>`, decisions, counsel result, open items, and its report's "decisions for the orchestrator" as `Carried` rows), then remove the workspace by its full path. Done when the gate on main is green, the row is written and the workspace is gone.

9. **Live check.** After each merge, or a small group of merges, run `NORTH_STAR.md` → Live check over every ability the batches changed (each apply report names them): the drive shows what rendered, the state view shows what happened. A defect found here becomes a live-fix batch (step 6). Done when the state matches the intent, the ledger has a live-check row, and every process the check started is stopped.

10. **Project files and docs.** Add re-proposable rejections to `NORTH_STAR.md` → Rejected and drop rows whose subject left the tree; move settled comparisons into `PRIOR_ARTS.md` → Settled; update the READMEs, `CONTEXT.md` and project skills wherever the pass changed an API, a workflow or a decision. Done when each describes the code as it is.

## Guardrails

A defect class found twice gets a check, built in the batch that fixes the second instance, placed by what can see it:

| The defect is                                                   | The check lives in                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A syntactic pattern (a banned call, an import shape)            | A lint rule, tested red on a fixture. A rule true of any Effect code goes upstream to `oxlint-plugin-effect` (`~/Developer/personal/effect-oxlint`), released there, and the project consumes the release; a project rule that duplicates an upstream one switches to upstream. A project-only rule goes in the repo's own oxlint plugin. |
| A layer importing one it must not                               | `no-restricted-imports` overrides in `.oxlintrc.json`, or the repo's boundary guard.                                                                                                |
| A wrong program the types could reject                          | The types, proved by an `@ts-expect-error` line in a `*.types.ts` test.                                                                                                             |
| A wrong result only running code shows                          | A test at the tier where the risk lives, red on the defect.                                                                                                                         |
| A test that waits a fixed time                                  | `effect/noFixedWaitInTests`; the test waits on the condition it asserts.                                                                                                            |
| A merge that took one side's file whole                         | A merge audit after every merge (redo git's merge of the two parents; print each line a parent added that the merge dropped).                                                      |
| A doc naming what the code no longer has                        | A docs test over the READMEs and project skills.                                                                                                                                    |

Hooks stay fast: pre-commit checks staged files only and finishes in seconds. A slow check goes into the gate and CI, never into pre-commit or pre-push.

## Close rule

Close when one pass holds all of these: no unswept directory; the architecture sweeps and package reviews report polish only (under about 5 lines of value each); every project pass meets its "done when"; `PRIOR_ARTS.md` → To survey is empty; no `Carried` row is open; and the loop reader names no structural change. A pass that finds a guard blind spot is never the last: close the blind spot, run the guard, and sweep what it reveals. Then write the HTML report from `~/.claude/skills/improve-codebase-architecture/HTML-REPORT.md` (one card per structural change the loop made, before and after) and the final message, ending with the ledger path.

## What pays late

After pass two, more reading finds little. These found the rest, so reach for them before another sweep: the coverage audit, guard blind spots (what can the lint rules, the types and the guards not see?), and live checks read through the state view.

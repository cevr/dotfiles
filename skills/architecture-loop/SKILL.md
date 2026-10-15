---
name: architecture-loop
description: improve-codebase-architecture judged against the project's NORTH_STAR.md and PRIOR_ART.md — one pass with the user picking and grilling, or autonomous passes until one finds polish only (sweep, review code and tests, apply in isolated workspaces, counsel, live-check, retro).
disable-model-invocation: true
---

# Architecture loop

This skill is a superset of `improve-codebase-architecture`: the same lens, judged against the project's north stars and prior arts. It runs one of two ways — a [single pass with the user](#single-pass-with-the-user), who picks and grills, or the autonomous loop below, where every finding is applied or rejected with a receipt.

In the loop, a **pass** is: coverage audit → read-only sweeps → triage into batches → per batch: a [track](../orchestrate/SKILL.md) (an implementor in the batch's own workspace, a reviewer from another model family, rounds until accepted) → merge → live check → count → [retro](retro.md). Passes repeat until the close rule holds. Within a pass, each **sweep** is one read-only lens over the code.

The project says what good is; this skill says how to loop:

- **`NORTH_STAR.md`** (repo root): north stars, tiebreaks, owner rules, project passes, live check, rejected candidates. Format: [`NORTH-STAR-FORMAT.md`](NORTH-STAR-FORMAT.md).
- **`PRIOR_ART.md`** (repo root): what to compare against, by pass, and the comparisons already settled. Format: [`PRIOR-ART-FORMAT.md`](PRIOR-ART-FORMAT.md).
- **The ledger**, `plans/architecture-loop-<date>.md`: the single source of truth for what is done, rejected, carried and open. Layout: [`ledger-template.md`](ledger-template.md).
- **Pass files** (briefs, reports, logs, counsel prompts) live in `tmp/architecture-loop/pass<N>/` in the checkout that holds the run's main (git-ignored). They are scratch and stay on the machine that ran them. Anything a later pass or a session on the other machine needs goes on the ledger.

Call the Skill tool with "codebase-design" once at the start; its glossary is the vocabulary of every prompt.

**Autonomy.** Never block on the human ([`never-block-on-the-human.md`](../../principles/never-block-on-the-human.md)): the owner supervises after the fact, and a decision can be reversed later. Decide by the principles in `~/Developer/personal/dotfiles/principles/` and write "decided by <principle>" on the ledger row. Every finding is applied or rejected with a receipt; the loop asks nothing. Six things stay with the owner:
- a persisted or wire format change that is not additive;
- a north-star conflict no tiebreak settles;
- removing a user-visible feature or a dependency that no north star names;
- a run that costs money beyond what the owner rules allow;
- publishing or deploying;
- pushing, unless the owner rules' Push line allows it.

Each becomes an owner question on the ledger, with your recommendation, and the user gets one short message. The loop carries on with everything else. A dialog that waits for an answer stalls every batch behind it: in one film run, five finished batches waited five hours on a single question.

**Owner direction.** Direction the owner gives mid-run goes, in the same turn and dated, into the file that owns it: `NORTH_STAR.md` → Owner rules for the loop's scope and standing rules, the project's skill for craft and voice, `AGENTS.md` for the stack. Every later brief carries it. Direction left in a pass file, or in memory (which is per machine and per account), had to be given three times. The loop's state lives on the ledger and in the run's unit folders. A feature the owner asks for mid-run is its own plan, not a batch of this loop.

**Pause.** On a pause, stop every agent you launched. Then write on the ledger where the pass stands. If a `/goal` is set, tell the user to clear it: its check-ins keep resuming the loop, and only the user can stop them.

**Safety.** [`safety.md`](safety.md) is the one copy of the safety rules. Every prompt the loop writes starts by sending the agent to read it, and `NORTH_STAR.md`'s owner rules, in full before any action.

## Single pass with the user

When the user wants to choose rather than hand off, read [`improve-codebase-architecture`](../improve-codebase-architecture/SKILL.md) (it is user-invoked only, so read it rather than calling it) and follow its process with these additions; everything else runs as written there.

- **Lens.** Besides `codebase-design`, the glossary and ADRs: `NORTH_STAR.md` (north stars, tiebreaks, owner rules, Rejected) and `PRIOR_ART.md` (comparisons, Settled). Read both first. When either is missing, establish it by [`ESTABLISHING.md`](ESTABLISHING.md), its with-the-user branch: candidates judged against no north star rank by taste. A north star, prior art or owner direction named in the prompt counts as written there; the last step writes it down.
- **Explore.** Spawn in one message the codebase walker (with [`agent-lens.md`](agent-lens.md)) and one agent per prior art whose "Compare with" paths overlap the scope, reading its "Read it for" paths and skipping what Settled answers. The walker also asks: where does the code break a north star, by its own "breaks when" column? A prior-art agent reports where the other codebase carries the same behavior with fewer concepts, and the seam it put there.
- **Report.** Each card adds **North star** (the one it serves, by its `NORTH_STAR.md` name; also a tag in the badge row) and **Prior art** (the codebase and path that already has the after shape, when one does). When Sideshow answers (`curl -sf -m 2 http://localhost:8228`), publish the report there as an html post; otherwise open it. The report stops at the problem and the direction; interfaces take shape in the grilling.
- **Settled decisions.** A candidate that trades one north star for another, contradicts an ADR, or reopens a `NORTH_STAR.md` → Rejected row is surfaced only when the friction warrants revisiting, with a warning callout (_"reopens Rejected: …, because…"_). A candidate against an owner rule is never listed.
- **Grilling** also covers which north star the candidate serves and which it strains. A load-bearing rejection becomes a `NORTH_STAR.md` → Rejected row (an ADR, linked, when it needs more than a line), instead of an offered ADR. A settled tiebreak or stated standing rule goes into `NORTH_STAR.md`, dated.
- **Project files.** Before finishing, bring both files up to date: north stars and prior arts the user named, comparisons the prior-art agents settled (into Settled), questions they left open (into To survey). Done when both files say everything the session decided.

## Sweeps

| Sweep          | Runs                                          | Agents                     | Method                                                    |
| -------------- | --------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| architecture   | every pass                                    | one per area               | [`prompts/sweep.md`](prompts/sweep.md), [`agent-lens.md`](agent-lens.md) |
| review         | every pass                                    | one per workspace package  | [`review.md`](review.md): slop and test value             |
| guardrails     | every pass                                    | one                        | `prompts/sweep.md`, guardrail focus; [`guardrails.md`](guardrails.md) |
| ui guidance    | every pass, in a repo with a UI               | one                        | [`ui-guidance.md`](ui-guidance.md) → For each role, Sweep |
| prior art      | first pass, then while To survey has rows     | one per source             | step 3                                                    |
| project sweeps | every pass, one per row of `NORTH_STAR.md` → Sweeps | one each             | the row's method                                          |

An **area** is a set of directories that change together (a package, or a layer of a large one). Areas cover every unswept directory first.

## Steps

0. **Project files.** When either file is missing, establish it by [`ESTABLISHING.md`](ESTABLISHING.md), its autonomous branch. Then read both. Direction in the user's prompt (north stars, prior arts, a new sweep, an owner rule) goes into them now, dated. So do standing rules about this repo found in project memory (`~/.claude*/projects/<repo>/memory/`) or in `AGENTS.md`. Where a rule disagrees with an owner rule, the newer statement wins and the older one is corrected, so `NORTH_STAR.md` is the one place that says what the loop may do. Push authority is the usual case. Done when both files exist, carry this run's direction, and each drafted north star is an owner question on the ledger.

1. **Open the ledger.** First `wc -c` the ledger; over about 100 KB, archive before you add the pass section (below). Copy the section layout of the newest `plans/architecture-loop-*.md`, or [`ledger-template.md`](ledger-template.md) when none exists. Record the HEAD hash and the baseline: source lines and files per package, by a `git ls-files` pathspec of source extensions that excludes tests and fixtures. Write the command on the ledger so every pass counts the same way; use `':(glob)…'` pathspecs, since a plain `*` crosses `/`. Keep each ledger row to one line. When the ledger passes about 100 KB, move closed passes into `plans/archive/`, keeping the baseline, Decisions, Rejected, Owner questions and open `Carried` rows. A ledger that every agent reads in full grew to 643 KB, past what Read accepts. Done when the ledger exists with a baseline.

2. **Coverage audit.** List every source directory with its file count (the baseline pathspec, `| xargs -n1 dirname | sort | uniq -c`). Mark each directory no earlier ledger or report names. Those go first. Done when every directory is marked swept-before or unswept.

3. **Prior art.** First pass, and any pass while `PRIOR_ART.md` → To survey has rows. One read-only agent per source to survey, reading only what Settled leaves open. Done when every new idea is a ledger row (adopt, or rejected with the north star it fails) and each answered question moved to Settled.

4. **Sweep.** Fill [`prompts/sweep.md`](prompts/sweep.md) into `<pass dir>/sweep-brief.md`, then launch every sweep of the table above in one message. Done when every area, package and sweep has a report, including those with no findings, and the ledger has each project sweep's row.

5. **Triage.** Group findings into batches by the files they touch. Every report's P3s and "not worth a pass" lines go to the batch that owns their file; that batch fixes each or rejects it with a reason. Write the pass section of the ledger: verdict, decisions, the triage table (batch, workspace, items), and the open `Carried` rows of the last pass, each in a batch or carried on. Done when every finding is in a batch or rejected with a receipt.

6. **Apply, review and verify, as orchestrate units.** Run the loop as the [`orchestrate`](../orchestrate/SKILL.md) orchestrator, one unit per batch, through its machine: plan, implement, review, verify, decide. The batch's apply agent is the unit's implementor, kept for round 2 and replaced by a fresh one after that (orchestrate's Fresh implementor).
   - **Workspace.** Each batch gets its own workspace from main on branch `p<N>-<batch>`, as `AGENTS.md` says. On a filesystem without reflinks (ext4), where Rift cannot clone, use a git worktree. Setup beyond install (a build, a linked git-ignored file, a shared lock for a heavy test) belongs in the project's `AGENTS.md`; a missing step found here goes there.
   - **Spec.** Fill each batch's spec from [`spec-template.md`](../orchestrate/spec-template.md). The apply prompt ([`prompts/apply.md`](prompts/apply.md)) supplies it:
     - its slots go to Goal, Workspace, Owns and Decided;
     - its work rules go to Work rules;
     - its Report goes into what each round request carries;
     - the counsel questions ([`prompts/counsel.md`](prompts/counsel.md)) go to Risks.

     The Gate is the repo's full gate, guards included. Hymn tracks were accepted on a narrower gate, then failed `dead-exports` on main.
   - **Counsel.** The unit's reviewer is the counsel round through the `counsel-review` skill: the other model family, fresh each round. It reviews every fixup round's delta until it accepts, or until the failure cap (3) sends the batch back to you as stuck. When the other model is unreachable, a fresh read-only agent reviews, and its ledger row says it was the same model family.
   - **Size.** A batch is one concern, about 10 items. An implementor that compacts within its first round is holding too much: split the batch then, not at the round's end, and one agent carries one deliverable (orchestrate's Units). In bible-tools, apply agents were 93% of all cache reads, and 124 of 288 hit the compaction window.
   - **Parallelism.** At most 3 heavy agents at once (orchestrate's Defaults: an agent that runs a gate or a browser counts, a unit does not), fewer when the gate cannot take them. Read the load before each start and start none above the core count. Time the gate once before the first wave. While a gate waits in the queue longer than twice its own run, start no new unit and make gate speed the next batch. Seven or eight parallel gates drove the workbox to a load of 540–830 and turned every e2e into a flake; on the laptop, seven agents at once drove a 12-core Mac to 38–45 and every e2e failure was a load-only timeout. A batch that needs another's files starts from main after that one merges.

   - **Cost.** At each hand-back, run `bun ~/.claude/skills/orchestrate/scripts/agent-cost.ts <agent id>` and append its line to the unit's `log.md`. A task notification's token count is the agent's final context, not its spend. An implementor that has compacted gets no further round; a fresh one takes the unit (orchestrate's Fresh implementor). The retro (step 11) reads these lines instead of rebuilding them.

   Done per batch when its unit passes verification.

7. **Merge.** Integrate as orchestrate's [pass](../orchestrate/SKILL.md#pass) step says:
   1. The branch contains today's main. If it does not, the implementor merges main in as a merge round. Conflicts are resolved by keeping both sides' edits, never one side's file whole, and then the merge audit in [`guardrails.md`](guardrails.md) runs over that merge.
   2. Run the gate at the branch head.
   3. `git merge --ff-only` it from the main checkout. Never commit a unit's work yourself.
   4. If the Push line allows it, push. Once CI finishes, read `gh run list --branch main --limit 1`. A red CI is the next batch: in gent, CI had failed on every run for twelve passes while the local gate stayed green.
   5. Write the batch's ledger row: `done <hash> … <hash>, merged <hash>`, decisions, the reviewer and its rounds, open items, and the report's "decisions for the orchestrator" as `Carried` rows.
   6. Stop the batch's agents.
   7. Delete the branch, and remove the workspace by its full path.

   Done when the gate on main is green, the row is written, and the branch and the workspace are gone.

8. **Live check.** After each merge, or a small group of merges, run `NORTH_STAR.md` → Live check over every ability the batches changed (each apply report names them): the drive shows what rendered, the state view shows what happened. A defect found here becomes a live-fix batch (step 6). Done when the state matches the intent, the ledger has a live-check row, and every process the check started is stopped.

9. **Project files and docs.** Add re-proposable rejections to `NORTH_STAR.md` → Rejected and drop rows whose subject left the tree; move settled comparisons into `PRIOR_ART.md` → Settled; update the READMEs, `GLOSSARY.md` (`CONTEXT.md` in a repo not yet renamed) and project skills wherever the pass changed an API, a workflow or a decision. Done when each describes the code as it is.

10. **Count.** Re-run the baseline command. The pass verdict carries lines and files per package against the baseline and against the last pass.
    - A pass whose net count grows names why: a bug fix with its test, a guard, or a north star that asks for the code.
    - Two growing passes in a row, with no north star asking for growth, become an owner question about scope.
    - A gent run whose goal was fewer concepts grew from 70k to 131k source lines, because no pass counted.

    Done when the pass row has its counts and, if it grew, its reason.

11. **Retro.** Run [`retro.md`](retro.md) over the pass: rounds, lost work, cost per accepted unit, hand work, checks a finding asked for, host breakages, what to remove, and the project's skills per domain (a map where agents re-explored, a rule they rediscovered, a stale line). Edits to this skill, `orchestrate`, the prompts and small project-skill corrections land now; project tooling and guards become the next pass's first batches. Done when `<pass dir>/retro.md` exists, every candidate has a destination, and the pass section has its `Retro:` line.

## Close rule

Close when one pass holds all of these: no unswept directory; the architecture sweeps and package reviews report polish only (under about 5 lines of value each); every project sweep meets its "done when"; `PRIOR_ART.md` → To survey is empty; no `Carried` row is open; and reading the pass's reports end to end, you can name no structural change left. A pass that finds a guard blind spot is never the last: close the blind spot with a check placed by [`guardrails.md`](guardrails.md), run it, and sweep what it reveals.

A loop that does not converge stops being a loop. A class of finding that returns in three passes in a row becomes an owner question about scope, not one more batch: gent's bash guard drew 85 commits over passes 8–19 before the owner made it opt-in. So does a pass made mostly of the last pass's regressions. Then run a retro over every pass's `retro.md` (did each applied action save what it promised?), and write the HTML report from [`improve-codebase-architecture`'s HTML-REPORT.md](../improve-codebase-architecture/HTML-REPORT.md) with the card additions under [single pass](#single-pass-with-the-user) (one card per structural change the loop made, before and after) and the final message, ending with the ledger path.

## What pays late

After pass two, more reading finds little. These found the rest, so reach for them before another sweep: the coverage audit, guard blind spots (what can the lint rules, the types and the guards not see?), and live checks read through the state view.

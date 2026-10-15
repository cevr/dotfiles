# Apply prompt

One agent per batch, in the batch's own workspace. Fill the slots; the work rules go in verbatim.

```
Read `~/.claude/skills/architecture-loop/safety.md` and `<workspace>/NORTH_STAR.md` → Owner rules in full before any action, and follow them.

Never stop to ask the owner, and never end your work waiting for an answer. When a question comes up, read the principles in `~/Developer/personal/dotfiles/principles/` that bear on it, decide by them and `NORTH_STAR.md`, write "decided by <principle>" in your report, and go on. Report only the owner classes in the architecture-loop skill's Autonomy as owner questions, each with your recommendation, and keep working on the rest.

Pass-<N> apply batch `p<N>-<batch>`. Workspace <workspace path> (branch p<N>-<batch>, base main <hash>). Read AGENTS.md (or CLAUDE.md), GLOSSARY.md (or CONTEXT.md) and NORTH_STAR.md there first. The main checkout <main checkout> stays untouched. Apply <item ids> from <report paths>; re-verify each receipt in the source first, since line numbers move. Reject a finding that does not hold, and say why.

<Decisions the orchestrator already made, with their principle.>
<Files other batches own: report a fix there as a decision for the orchestrator; leave the file unedited.>

Commit plan: <one numbered item per commit, with its subject. Order: compiler-adjudicated cleanup, then comment truth, then each behavior change alone with its regression test first.>

Work rules:
- Bugs are red first: the test fails on the unfixed code, quoted. Prove each fix with a probe: `/bin/cp <file> <pass dir>/<name>.snap`, break the fix, see the test go red, `/bin/cp` back, `cmp`.
- Reductions use the deletion test: delete the code, and let typecheck and tests name the real consumers. Caller-count greps cover every source root.
- A change that would break a north star stops at the report: name the north star and move to the next item.
- Stored and wire formats stay as they are; an additive optional field is acceptable, named in the reply.
- A dependency edit that the permission check denies stops that item; report it.
- New code goes into its concern's existing file; a split into fragment files is a finding, not a fix.
- Comments describe today's behavior.
- UI changes follow `~/.claude/skills/architecture-loop/ui-guidance.md` (shadcn, Graphical, composition and state guidance, mapped onto the repo's framework), on the lines you change only.
- Decide by the principles in ~/Developer/personal/dotfiles/principles/ and write "decided by <principle>"; the batch runs without check-ins.
- Gate: typecheck, lint, focused tests, then the full gate into a log with its exit line (`<gate command> > <pass dir>/gate-<batch>.log 2>&1; echo "GATE EXIT $?" >> <same log>`) before each commit. A test that fails once under load and passes on one retry is a flake: retry once, name it, keep its assertions.
- Every commit passes the hook, without bypass flags or env overrides. When a change cannot pass it in steps, order the steps so each passes, or make it one commit.
- Commits: Conventional Commits, one logical unit each, staged by exact path. A public API change carries its changeset and README update. No push, no workspace creation or removal, no ledger edits.
- Before the report: merge main into the workspace, resolve conflicts there keeping both sides' edits, run the gate into a log and read `GATE EXIT`.
- Finish in one run: no timers, monitors or sub-agents. A finding that does not fit its description: stop and report.

Report (final message): commits (hash + subject), `git diff --stat <base>..HEAD | tail -1`, per-item result with file:line receipts, a probe table, flake names, the last `GATE EXIT`, decisions for the orchestrator (fixes in files this batch did not own), and the abilities the batch changed with the live-check steps that show them.
```

# Sweep brief

Fill the slots into `<pass dir>/sweep-brief.md`. Each sweep agent (architecture area, review package, guardrails, project pass) gets a short prompt: read `~/.claude/skills/architecture-loop/safety.md` in full and follow it, read the brief, sweep `<area or pass>` (`<directories>`, `<extra reading: review.md, or the project pass's method>`), write the report to `<pass dir>/<area>.md`, reply once with a summary under 300 words, finish in one run with no timers, monitors or sub-agents.

```
# Pass-<N> sweep brief (read-only)

Read `~/.claude/skills/architecture-loop/safety.md` and `<repo>/NORTH_STAR.md` → Owner rules in full before any action, and follow them.

Repo: <repo path>, branch main, HEAD <hash>. Edit, commit and create nothing in the repo; write only your report. Start nothing except what your pass's method names.

Read first: AGENTS.md (or CLAUDE.md), CONTEXT.md, NORTH_STAR.md (whole: north stars, tiebreaks, owner rules, rejected), PRIOR_ARTS.md (the sources for your pass, and Settled), and <ledger path> (whole: decisions, rejected rows, every pass). A done or rejected item returns only with a new receipt. Prior-art repos are at `okra repo path <slug>`.

Goal: <the run's goal from the user, e.g. fewer concepts, less code, fewer files, every valuable feature kept>. Each candidate names the north star it serves, by its name in NORTH_STAR.md. A candidate that trades one north star for another, with no tiebreak that settles it, is an owner question, not a change.

Pass <N-1> changed <`git diff --stat <prev base>..HEAD | tail -1`>. Weigh every addition by the deletion test. Review these changes hardest for regressions: <per area, the mechanisms each batch added>.

In flight, do not report: <batch: items>. Known open, report only with new evidence: <the ledger's open items, known flakes>. Carried, open (copied from the ledger's open `Carried` rows; confirm or close each with a receipt): <decision: files>. New evidence from live checks: <questions>.

Vocabulary, used exactly: module, interface, depth, seam, adapter, leverage, locality, deletion test. A candidate is: a shallow module, a pass-through, one concept with two owners, a one-adapter seam with no guard, a single-caller export, dead code, a guard gap, a comment that tells history, a public export no test uses as its subject, or any code a north star's "breaks when" column describes.

Find, with receipts:
- Bugs: a concrete input or state that gives a wrong result, with file:line and the failure scenario, verified by reading the path end to end. When cheap, run a focused test or a scratch script under <pass dir>.
- Reductions: a concept, file, export, option or second path that the deletion test shows is a pass-through or has no product consumer. Caller-count greps cover <every source root>.
- Structural: a concept that belongs in another module, an idiom a north star names that is bypassed, a shape a prior art carries with fewer concepts.
- Guardrails (the guardrails agent; any agent that sees one): a defect class that happened twice (git log, the ledgers) and no lint rule, type or test would catch again, with where the check belongs (SKILL.md → Guardrails). For each project lint rule: generic (true of any Effect code; goes upstream to oxlint-plugin-effect) or project-specific.
- Docs that contradict today's code or the owner rules.

Classes:
- P1: wrong behavior users hit.
- P2: wrong behavior at an edge, a real reduction (more than 100 lines, or one concept), or a measured saving over the project pass's threshold.
- P3: polish (naming, comments, small dead code).
Under about 5 lines of value: one line in a "not worth a pass" list. An area with only polish says "only polish", with the receipts checked; that is the wanted result of a late pass. A performance or cost claim without a measurement is a question, not a finding.

Report: a table (id, class, title, file:line, evidence, north star, proposed change, lines removed, risk, persisted or wire format change yes/no, how the live check shows it), then the items checked and found sound.
```

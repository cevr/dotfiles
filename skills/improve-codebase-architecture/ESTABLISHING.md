# Establishing NORTH_STAR.md and PRIOR_ARTS.md

For a repo that has neither file, or only one. North stars are product direction: the owner holds them, and the agent drafts them from evidence for the owner to confirm. Prior arts are research: the agent finds and reads them. Formats: [NORTH-STAR-FORMAT.md](NORTH-STAR-FORMAT.md), [PRIOR-ARTS-FORMAT.md](PRIOR-ARTS-FORMAT.md).

## 1. Gather evidence

A project already enforces its north stars; they are written down as rules, refusals and reverts before anyone names them. Collect, with a path or hash for each item:

- **What the owner said.** The user's prompt for this run, dated owner statements in the agent's memory for this repo, the "why" sections of the README, `AGENTS.md`/`CLAUDE.md`, `CONTEXT.md`, ADRs and design docs.
- **What the code enforces.** Lint config and the repo's own lint plugin, guards, boundary checks, the type settings, the test helpers. Each rule is some north star's "breaks when", written as code.
- **What the history refused.** `git log` for reverts, "refuse", "no-" and "never" commits, and the rejected rows of earlier ledgers or reviews. A reverted change marks a line the owner holds.
- **The owner's principles** in `~/Developer/personal/dotfiles/principles/`. They hold across projects; a north star is the form one takes in this project, with this project's nouns.

Done when every source above is read and each item has its receipt.

## 2. Draft NORTH_STAR.md

- **Cluster the evidence into qualities.** A cluster with two or more independent receipts is a north star; name it in the owner's words when they used any. Three to nine.
- **Prove each row in the code.** Find one file:line where it holds and, when there is one, one where it breaks. A row with no file:line on either side is a value, not a north star yet; cut it.
- **Name the tensions.** Where two clusters pull opposite ways (speed against the look, brevity against explicitness), draft the tiebreak the evidence points to. A tension with no evidence either way is an owner question.
- **Owner rules** are the evidence stated as must or never: a stored format, a UX rule, a run that may cost money, a capability kept on purpose.
- **Rejected** starts from earlier ledgers and ADRs; empty is fine.
- **Sweeps** only for a quality reading code cannot judge: cost per task, frame time, a rendered UI. The instrument that measures it shapes the sweep's method.
- **Live check** comes from the package scripts or a project `run` skill: the command that drives the product, and the one that shows its state. No state view: write "none"; building one is a candidate.

Mark every row the owner has not stated as drafted, as the format's "Drafted rows say so" rule describes.

## 3. Find prior arts

Prior art is a project that solved the same problem in a different shape. Look for one per north star and one per major module:

1. **Named by the owner**, in the prompt or the evidence.
2. **Built on and beside**: the libraries the project depends on most (their own internals are often the idiom), and the main alternatives to each.
3. **Same problem, different stack**: `gh search repos "<the problem in plain words>" --sort stars`, and the `research` skill for write-ups and posts. Prefer projects with commits in the last six months that hold one of the north stars most strongly.

Keep three to eight sources. For each repo: `okra repo fetch <slug>`, read its entry point and the module that matches ours, then fill "Read it for" with the paths actually read and "Compare with" with ours. A source not yet read goes into To survey, not into a row. Seed To survey with one question per north star: how does the strongest source hold it?

Done when every row was read, and every north star has at least one source or a To survey question.

## 4. Confirm

- **With the user present** (`improve-codebase-architecture`): show the north stars table, the tiebreaks and the sources, then call the Skill tool with "grilling", limited to what changes the files: a north star that is wrong, one that is missing, each tiebreak. Write the answers in and remove their `(drafted …)` markers.
- **Autonomous** (`architecture-loop`): write each drafted north star and tiebreak as an owner question on the ledger, and carry on. A drafted north star guides sweeps; a change that removes behavior and that only a drafted north star justifies waits for the owner's answer.

Commit both files on their own (`docs: establish north stars and prior arts`), with the evidence receipts in the commit body, so the files stay in today's tense and the reasons stay findable.

# Decision trail

A long run keeps one reviewable record of its decisions: what was chosen, why, and the pointer that proves it. Adapted from pstack (`cursor/plugins`, `pstack/skills/show-me-your-work`), MIT.

It is the record of a long or unattended orchestrate run, and the first thing a replacement root reads, before the units' `state.md` files.

## The file

`<run dir>/decisions.tsv`: one append-only TSV, one row per decision, with a header row and the columns in this order:

- `ts`: ISO 8601 time, UTC.
- `phase`: the phase, unit or batch the row belongs to.
- `decision`: what was chosen or done, one line, in plain words.
- `why`: the reason, plainly; a principle that drove it is named in words.
- `evidence`: a pointer, never prose: a commit, a `file:line`, a path (a findings file, a gate log, a receipt).
- `result`: the outcome: `green`, `changes`, `reverted`, `open`, `blocked`.

Every cell is a single line, with no tab in it.

## Appending a row

```bash
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" batch-2 "landed verify-bar alone" "skill-modes conflicted on SKILL.md" "<run dir>/batch-2-findings.md" green >> "<run dir>/decisions.tsv"
```

A cell that comes from generated text has its tabs and newlines replaced by spaces first.

Log decision points and checkpoints, not every action: a fork chosen, a unit landed with its verdict, a pivot or revert and what triggered it, a blocker raised, a gate fixed. Skip what is trivial or self-evident.

## Rules

- Append-only. A wrong call gets a new row that supersedes it, naming the row's `ts`; never edit or delete a row.
- A replacement agent's first row has phase `start`: it names the `ts` range of the rows it did not write, and its evidence names the agent. Phase `start` means nothing else.
- Before appending in a later turn, read the last rows to see whether another agent wrote since.

Read it with `column -s$'\t' -t decisions.tsv`, top to bottom, following the pointers.

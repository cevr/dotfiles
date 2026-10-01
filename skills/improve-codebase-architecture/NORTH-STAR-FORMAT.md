# NORTH_STAR.md Format

`NORTH_STAR.md` sits at the repo root and states what good means for this project: the qualities every candidate serves, the owner's standing rules, the passes that test them, and the candidates already rejected. `improve-codebase-architecture` reads it; `architecture-loop` reads it in every sweep, apply and counsel prompt.

## Structure

```md
# North star

{One or two sentences: what the project is becoming.}

## North stars

| North star        | It holds when                                                                        | A candidate breaks it when                                                     |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Effect-native** | Work is an `Effect`, `Stream` or `Layer`; lifetimes are `Scope`s; failures are typed. | It adds a Promise, a manual cleanup list or an untyped `throw` where Effect has the tool. |
| **Lean core**     | Core owns only what every extension needs; a feature is an extension first.          | Core grows a feature one extension could own.                                  |

## Tiebreaks

- **Explicit** beats **Expressive**: shorter code that hides an ID, a scope or a placement is rejected.
- **Art direction** beats **Performant** (owner, 2026-09-27): a speed change that moves pixels needs owner approval.

## Owner rules

Propose nothing against these.

- Children wake, never block.
- No persisted-format change unless it is additive and optional.
- A live run uses `--debug` with its data directory under the scratch directory.

## Passes

Run every loop pass beside the standard passes (architecture areas, package review, prior art, guardrails).

| Pass       | Serves           | Scope                    | Method                                   | Done when                                           |
| ---------- | ---------------- | ------------------------ | ---------------------------------------- | --------------------------------------------------- |
| efficiency | Lean core        | what the harness sends   | [docs/architecture/efficiency.md](...)   | no measured saving left that it can change directly |
| ui         | Consistent UI    | the rendered TUI         | [docs/architecture/ui.md](...)           | a matrix row per checklist moment, gent × each reference |

## Live check

How to drive changed behavior in the real product, and what shows the state behind what rendered.

- Drive: `bun run gamut up <preset> --prompt <file>`, keys through `herdr pane send-text`.
- State: `bun run gamut status` prints the stored messages and the session tree.
- Stop: `bun run gamut down`.

## Rejected

A sweep re-proposes a row only with a new receipt. A row leaves when its subject leaves the tree.

| Candidate                        | Why it stays                                              |
| -------------------------------- | --------------------------------------------------------- |
| Fold the cell trio into one file | a process entry and a shared wire module (2026-09-22 ledger) |
```

## Rules

- **North stars are observable.** Each has a _holds when_ a reader can check in code and a _breaks when_ a sweep can point at with a file:line. "Clean", "maintainable" and "simple" are not north stars; name what makes them true here.
- **Three to nine north stars.** More than nine means some are tiebreaks or owner rules.
- **Every tiebreak names a winner and a loser**, plus what the loser's candidates look like when rejected. Date owner tiebreaks.
- **Owner rules are product direction**, the decisions a sweep may not reopen: a stored format, a UX rule, a capability kept on purpose, a run that may cost money. Project safety (a live binary, the owner's data, paid runs) goes here too. Date a rule when it comes from a session.
- **Passes are project-specific only.** The architecture sweep, the package review, prior art and guardrails run everywhere and are not listed. A pass row names the north star it measures and a method; a method longer than three lines lives in its own repo doc, linked from the row. A pass that compares against other products takes its references from `PRIOR_ARTS.md`.
- **Live check names a drive and a state view.** The drive shows what rendered; the state view (a status command, an inspector, a database copy) shows what happened. A project with no state view says so, and building one is a candidate.
- **Rejected rows carry their reason in one line**: the north star or owner rule the candidate breaks, or the receipt that sank it, with the ledger that decided it. A reason that needs a paragraph is an ADR (`docs/adr/`), and the row links it.
- **Write in today's tense.** Each line describes the project as it is and the rule as it stands; history lives in the ledgers.

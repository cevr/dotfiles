# Unit spec template

One copy per unit, in `<run dir>/<unit>/spec.md`, written for a capable reader with no context. The shared rules live in `protocol.md`.

```markdown
# <unit> — spec (orchestrator-owned; agents do not edit it)

Run `<run>` · unit dir `<run dir>/<unit>` · failure cap 3 · timebox <hours per round>
Mode: <single fix | lane | batch | deep | long run>: <why; for deep, why a defect is costly>.

## Goal
<The result, in the user's words where they gave any; what is done, what other units do.>

## Workspace
<workspace path>, branch `<branch>`, base `<main hash>`. Project rules: <AGENTS.md, NORTH_STAR.md paths>.

## Owns
<The files this unit may change; a fix needed elsewhere is a follow-up in state.md.>

## Do not touch
<Files running units own; shared resources (ports, the e2e lock, a branch stack) and the one owner of each.>

## Acceptance check
<Runnable, written first, red now: the commands and the result that means done. A rule gets a generated property; behavior over time a model-based test; interleaving a Quint or TLA+ model. `verify-<app>` feature ids where the repo has the skill.>

## Gate
Round gate: <the focused checks as commands, into `<unit dir>/gate-N.log`, and its receipt; never the full gate or e2e.>
Lands: <`push` (at once on its receipt, or with its batch) or `PR` (draft PR, ready on `accepted`)>, through the land's merge check.
CI: <the workflow and its trigger, or `none`.>

## Risks
<What the verifier should attack hardest: invariants, formats that must still decode, traps.>

## Decided
<Choices already made, each with its principle.>

## Work rules
<Optional: rules a calling skill gives this kind of unit (loop's apply prompt), and what each request carries beyond protocol.md's list.>

## Reserved
<Actions only the orchestrator or the user takes: merge, push, deploy, publish, paid calls.>
```

A spec that still says `Path:` reads as: `direct` and `light` → lane with no planner, `standard` → lane, `deep` → deep.

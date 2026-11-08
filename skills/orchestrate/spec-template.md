# Unit spec template

The planner fills one copy per unit into `<run dir>/<unit>/spec.md`, and the orchestrator approves it before the unit is implemented. The spec is the planner's output. The implementor builds against it, and its batch's verifier runs its acceptance check and judges the unit's diff against it. Write it for a capable reader with no context, and keep it to what this unit needs: the shared rules live in `protocol.md`.

```markdown
# <unit> — spec (orchestrator-owned; agents do not edit it)

Run `<run>` · unit dir `<run dir>/<unit>` · failure cap 3 · timebox <hours per round>
Machine: plan → implement (focused checks only) → ready → lands in a batch (one merge, one batch gate, then the push: main, or in a PR repo the unit's branch and its draft PR) → verify (one fresh verifier for the batch, on its merged head: the batch acceptance once, this unit's diff against this spec) → merged, or the next round fixed forward.
Path: <direct | light | standard | deep>: <why; for direct, that the diff is prose only; for deep, why a defect is costly or why the check is a live drive>.
Protocol: a role agent carries it in its prompt; any other worker reads `~/.claude/skills/orchestrate/protocol.md` in full first.

## Goal
<One paragraph: the result, in the user's words where they gave any. What is already done, what other units are doing.>

## Workspace
<Rift or worktree path>, branch `<branch>`, base `<main hash>`. Project rules: <AGENTS.md / CLAUDE.md / NORTH_STAR.md paths>.

## Owns
<The files and directories this unit may change. Everything else is read-only; a fix needed elsewhere is a follow-up in state.md.>

## Do not touch
<Files that running units own; shared resources (migration numbers, lab and debug (CDP) ports, sequence ids, a branch stack, the e2e lock) and the one unit that owns each.>

## Acceptance check
<Objective, runnable, written before any code: the commands, and the result that means done. Prefer a test that is red now and must go green, a parity or golden diff, a live drive with its expected state, a benchmark against its baseline. A rule gets a generated property over its whole domain; behavior over time gets a model-based test against a reference model; interleaving concurrency also gets a checked Quint or TLA+ model, named here with its invariants. "Looks right" is not a check. When the repo has a `verify-<app>` skill, name its feature and sub-feature ids, plus any rows this unit adds to its map.>

## Gate
Round gate: <the focused checks as commands, logged to `<run dir>/<unit>/gate-N.log`: the tests and typecheck of the packages Owns covers, lint of the changed files, and this unit's acceptance test file alone. Never the full gate, the full e2e or an affected-acceptance run.>
Batch gate: <the repo's full gate command, its guards included (a dead-exports or boundary check that only CI or main runs is still the gate); where CI is the thorough gate, the repo's quick local pass (e.g. Bite on the workbox: `bun bite gate --branch --with-infra --require-db`, its unit suites on the local Mongo). The orchestrator runs it once per batch, before the push, as a heavy job, in every repo, CI repos included.>
Batch accept: <the repo's full acceptance or e2e run affected since the batch base (`accept:affected "$RIFT_LAND_BASE"` and the like), run once per batch after the push, by `rift land`'s `rift.accept` or the batch verifier; or `none`.>
Lands: <`push` (a green batch pushes main before its verify, and a red verify is fixed forward) or `PR` (a team repo: a green batch pushes each unit's branch and opens or updates its PR as a draft, marked ready once the batch verifier accepts it; main is never pushed).>
CI: <the CI workflow that runs the suite on a pushed head, or `none`; for a PR repo also its trigger and suites (e.g. a `/pipeline vitrine route` comment on a stack's top PR). Named: CI runs after a green batch gate, never in its place: on main after the push, or on each unit's PR.>
Batch cadence: <default: land when 3 units are ready or the oldest ready unit has waited 30 min, whichever comes first; or this unit's override and why.>

## Risks
<What could go wrong in this unit, alone or merged with the units beside it, and what the verifier should attack hardest: invariants a refactor must keep, formats that must still decode, traps earlier units found.>

## Decided
<Choices the orchestrator already made, each with its principle.>

## Work rules
<Optional: rules this kind of unit always follows, quoted from a calling skill (e.g. loop's apply prompt), and anything each round request must carry beyond protocol.md's list.>

## Reserved
<Actions only the orchestrator or the user takes: merge, push, deploy, publish, paid calls, non-additive format changes.>
```

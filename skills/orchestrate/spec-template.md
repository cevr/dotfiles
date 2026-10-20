# Unit spec template

The planner fills one copy per unit into `<run dir>/<unit>/spec.md`, and the orchestrator approves it before the unit is implemented. The spec is the planner's output. The implementor builds against it, the reviewer judges against it, and the verifier runs its acceptance check. Write it for a capable reader with no context, and keep it to what this unit needs: the shared rules live in `protocol.md`.

```markdown
# <unit> — spec (orchestrator-owned; agents do not edit it)

Run `<run>` · unit dir `<run dir>/<unit>` · failure cap 3 · timebox <hours per round>
Machine: plan → implement → review (okra counsel, the other model family) → verify (fresh agent, clean checkout) → decide.
Review: <standard | deep: why a defect here is costly>.
Protocol: `~/.claude/skills/orchestrate/protocol.md` (read it in full first).

## Goal
<One paragraph: the result, in the user's words where they gave any. What is already done, what other units are doing.>

## Workspace
<Rift or worktree path>, branch `<branch>`, base `<main hash>`. Project rules: <AGENTS.md / CLAUDE.md / NORTH_STAR.md paths>.

## Owns
<The files and directories this unit may change. Everything else is read-only; a fix needed elsewhere is a follow-up in state.md.>

## Do not touch
<Files that running units own; shared resources (migration numbers, lab and debug (CDP) ports, sequence ids, a branch stack, the e2e lock) and the one unit that owns each.>

## Acceptance check
<Objective, runnable, written before any code: the commands, and the result that means done. Prefer a test that is red now and must go green, a parity or golden diff, a live drive with its expected state, a benchmark against its baseline. "Looks right" is not a check. When the repo has a `verify-<app>` skill, name its feature and sub-feature ids, plus any rows this unit adds to its map.>

## Gate
<The repo's full gate command, its guards included (a dead-exports or boundary check that only CI or main runs is still the gate); where the log goes (`<run dir>/<unit>/gate-N.log`).>

## Risks
<What could go wrong in this unit and what the reviewer should attack hardest: invariants a refactor must keep, formats that must still decode, traps earlier units found.>

## Decided
<Choices the orchestrator already made, each with its principle.>

## Work rules
<Optional: rules this kind of unit always follows, quoted from a calling skill (e.g. architecture-loop's apply prompt), and anything each round request must carry beyond protocol.md's list.>

## Reserved
<Actions only the orchestrator or the user takes: merge, push, deploy, publish, paid calls, non-additive format changes.>
```

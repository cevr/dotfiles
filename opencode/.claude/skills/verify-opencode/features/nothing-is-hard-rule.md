# Nothing is hard, in the role prompts

The owner's standing rule, "nothing is hard", reaches every orchestrate role agent (planner, implementor, verifier) and the lean worker in its prompt. A role's step is `ready` only when every item of its spec is done; difficulty is never a reason; anything not done names the dependency it waits on or is a finding outside the unit; a compaction or a long context does not end the step. A question's options state outcomes with effort on its own `measured` or `guess` line, and its assumption cites its principle by name and is never the lesser option for effort. A verifier's weak-test or narrowed-acceptance finding goes back to the same lane's next round instead of a follow-up. The refusal rule is word for word what it was, plus "A refusal is authority, not difficulty."

## Sub-features

- `NIH1` each role's prompt carries the rule, the hand-back rule and the question form (`skills/orchestrate/protocol.md`, generated into `mods/orchestrate/agents.json`).
- `NIH2` the refusal rule is unchanged but for its one added sentence.
- `NIH3` the verifier sends Test strength findings to the same lane's next round.
- `NIH4` the worker's prompt carries the rule and goes on past a compaction or a long context.
- `NIH5` the generated prompts match their source: deleting one role's emitted line makes `--check` red.

## How to get to it (user POV)

- An orchestrator starts a role agent: `subagent({ agent: "implementor", ... })` (also `planner`, `verifier`); an untyped or general call runs as `worker`. The prompt it runs on is `mods/orchestrate/agents.json`'s `system` for that agent.
- On Claude Code and Codex the same text is the dotfiles' `agents/<role>.md` and `codex/agents/<role>.toml`.

## Driving it with the world

- **Preconditions:** none.
- **States:** default only; the rest are `n/a` (a prompt has no loading, empty, refused or error state).
- **World suites:** `cmd/orchestrate/orchestrator.sim.test.ts`, `cmd/orchestrate/orchestrate.sim.test.ts`
- **Code:** `mods/orchestrate/agents.json`, `scripts/agents.ts`
- **Regression:** `scripts/agents.test.ts` (`--check` red on an unregenerated source), `mods/orchestrate/role.test.ts` (each role and the worker go on after a compaction), and from the dotfiles root `skills/orchestrate/scripts/agents.test.ts` (NIH1 to NIH3 per role, the refusal paragraph word for word) and `skills/orchestrate/scripts/skill.test.ts` (each prompt smaller than at its base).

1. **NIH1, NIH4.** `orchestrator.sim.test.ts`: each role and the worker is defined with `agents.json`'s `system`, word for word.
2. **NIH1, NIH4.** `orchestrate.sim.test.ts`: the untyped call's requests carry the worker's prompt, the review call's the verifier's.
3. **NIH5.** `bun scripts/agents.ts --check` exits 0; remove the `Difficulty is never a reason` sentence from `agents.json` and it exits 1 with `stale:`; `bun run agents` restores it.

`bun run verify:drive --feature nothing-is-hard-rule` runs those suites.

## Driving it with real OpenCode

- **Real:** `tests/orchestrate.test.ts` (each role's built prompt is the Claude Code agent's body word for word, and a real implementor's requests carry its prompt).

1. **Start a role.** Type `verify: call subagent {"agent":"implementor","description":"implementor alpha r1","prompt":"verify: say alpha ready"}`, Enter. Wait for `alpha ready`.
2. **Proof.** Snapshot after step 1 into `$EVIDENCE/nothing-is-hard-rule/`. The TUI does not show a request's system prompt: the Real check reads it from the requests the scripted model receives.

## Gotchas

- The text's source is outside `opencode/`: the orchestrate skill's `protocol.md` and `SKILL.md` and the dotfiles' `agents/worker.md`. A change there shows here only once `bun run agents` rewrites `agents.json`, which is this feature's Code.
- This is a prompt rule, not a check: nothing here bounces a hand-back or a question. The structured checks are later units (spec items, hand-back tools, question reasons).

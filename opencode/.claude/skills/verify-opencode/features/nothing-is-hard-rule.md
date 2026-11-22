# Nothing is hard, in the role prompts

The owner's standing rule, "nothing is hard", reaches every orchestrate role agent (planner, implementor, verifier) and the lean worker in its prompt. How a step ends is one decision table (`skills/orchestrate/scripts/ending.ts`): role (planner, implementor, verifier, lean worker) by why the step ended (done, a refusal with or without a named form, the round's limit, a check that cannot run, only waiting work) by the state of each item left (the item the end stopped, one that waits, work no spec item asks for, a runnable one). Every cell holds one verdict the role is allowed, one file and one label, or says why it cannot occur; each role's prompt carries its rows as one generated block, and no other sentence of a prompt states how a step ends. Difficulty is never a reason; a compaction or a long context does not end the step. A question's options state outcomes with effort on its own `measured` or `guess` line, and its assumption cites its principle by name and is never the lesser option for effort. A weak test, narrowed acceptance or written-rule break goes by where it came from: one the unit's change introduced to the same lane's next round, one the base head shows too to a follow-up unit; none fails a round. The refusal paragraph is word for word what it was, plus "A refusal is authority, not difficulty."; the principle leaves every refusal, with or without a named accepted form, to the role's rule. A follow-up is work no spec item asks for, even inside a file the unit owns. The lean worker is told a refusal is the host's rule and outranks effort, with no bound-step instruction.

## Sub-features

- `NIH1` each role's prompt carries the rule, the hand-back rule and the question form (`skills/orchestrate/protocol.md`, generated into `mods/orchestrate/agents.json`).
- `NIH2` the refusal rule is unchanged but for its one added sentence.
- `NIH3` findings route by provenance: the unit's own to its lane's next round, the base's to a follow-up unit.
- `NIH4` the worker's prompt carries the rule and the refusal-authority reminder, and goes on past a compaction or a long context.
- `NIH6` the prompts reach the agents: a root offered `subagent` and `principles` starts one child of each role, each child's model request carries its role's prompt, its required-work line and the principle's name, and `principles` list and search answer principle-nothing-is-hard.
- `NIH5` the generated prompts match their source: deleting one role's emitted line makes `--check` red.
- `NIH7` the end-of-step table is total (every cell one outcome or a named impossibility), each prompt carries exactly its role's rows, and a sentence outside them that names a verdict, a hand-back or a label is red unless it is one of the few allowed ones.

## How to get to it (user POV)

- An orchestrator starts a role agent: `subagent({ agent: "implementor", ... })` (also `planner`, `verifier`); an untyped or general call runs as `worker`. The prompt it runs on is `mods/orchestrate/agents.json`'s `system` for that agent.
- On Claude Code and Codex the same text is the dotfiles' `agents/<role>.md` and `codex/agents/<role>.toml`.

## Driving it with the world

- **Preconditions:** none.
- **States:** default only; the rest are `n/a` (a prompt has no loading, empty, refused or error state).
- **World suites:** `cmd/orchestrate/nothing-is-hard.sim.test.ts` (NIH6), `cmd/orchestrate/orchestrator.sim.test.ts`, `cmd/orchestrate/orchestrate.sim.test.ts`
- **Code:** `mods/orchestrate/agents.json`, `scripts/agents.ts`
- **Regression:** `scripts/agents.test.ts` (`--check` red on an unregenerated source), `mods/orchestrate/role.test.ts` (each role and the worker go on after a compaction), and from the dotfiles root `skills/orchestrate/scripts/agents.test.ts` (NIH1 to NIH3 per role, the refusal paragraph word for word), `skills/orchestrate/scripts/ending.test.ts` (NIH7: totality, the named cases of batches 22q, 22r and 22s, the structural lint in every host format, and a changed cell, a deleted row and an appended sentence each red), `skills/orchestrate/scripts/scenarios.test.ts` (the rows the table does not cover: the principle, routing, questions, the worker's reminder) and `skills/orchestrate/scripts/skill.test.ts` (each prompt within its byte bound).

1. **NIH6.** `nothing-is-hard.sim.test.ts`: the default root is offered `subagent` and `principles`; both lookups answer the principle; the planner, implementor and verifier children's requests carry their prompts, required-work lines and the principle's name.
2. **NIH1, NIH4.** `orchestrator.sim.test.ts`: each role and the worker is defined with `agents.json`'s `system`, word for word.
3. **NIH1, NIH4.** `orchestrate.sim.test.ts`: the untyped call's requests carry the worker's prompt, the review call's the verifier's.
4. **NIH5.** `bun scripts/agents.ts --check` exits 0; remove the `Difficulty is never a reason` sentence from `agents.json` and it exits 1 with `stale:`; `bun run agents` restores it.

`bun run verify:drive --feature nothing-is-hard-rule` runs those suites.

## Driving it with real OpenCode

- **Real:** `tests/orchestrate.test.ts` (each role's built prompt is the Claude Code agent's body word for word, and a real implementor's requests carry its prompt).

1. **Start a role.** Type `verify: call subagent {"agent":"implementor","description":"implementor alpha r1","prompt":"verify: say alpha ready"}`, Enter. Wait for `alpha ready`.
2. **Proof.** Snapshot after step 1 into `$EVIDENCE/nothing-is-hard-rule/`. The TUI does not show a request's system prompt: the Real check reads it from the requests the scripted model receives.

## Gotchas

- The text's source is outside `opencode/`: the orchestrate skill's `protocol.md`, `SKILL.md` and `skills/orchestrate/scripts/ending.ts` (whose rows `skills/orchestrate/scripts/agents.ts` writes into each prompt, `agents/worker.md` and `skills/orchestrate/end-of-step.md`) and the dotfiles' `agents/worker.md`. A change there shows here only once `bun run agents` rewrites `agents.json`, which is this feature's Code.
- On the installed host the kernel plugin runs with `codeOnly` (its default): a model is offered `kernel` and the memory tools alone, and `subagent` and `principles` are lines in the kernel's description, called from a cell (`cmd/kernel/server.ts` line 145; the fork's `packages/core/src/tool.ts` `runtimeSnapshot`). A scripted model that looks for `subagent` or `principles` among a request's offered tools finds neither there; the world, which hosts no kernel (`kernel.md`), offers them directly.
- This is a prompt rule, not a check: nothing here bounces a hand-back or a question. The structured checks are later units (spec items, hand-back tools, question reasons).

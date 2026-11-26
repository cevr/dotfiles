# Nothing is hard, in the role prompts

The owner's standing rule, "nothing is hard", reaches every orchestrate role agent (planner, implementor, verifier) and the lean worker in its prompt. The prompts are short (about 5k characters for the implementor and the verifier): the safety rules, protocol.md's Every role section (the brief is the whole bar, finish every item, the hand-back stat block, questions to the orchestrator, refusals) and the role's own section. A verifier runs what was built and files only failures a run proves, in three verdict words: `pass`, `issues`, `blocked`.

## Sub-features

- `NIH1` each role's prompt carries the rule, the hand-back stat block and the question rule (`skills/orchestrate/protocol.md`, generated into `mods/orchestrate/agents.json`).
- `NIH2` each role's prompt carries the refusal rule: stop and report, never work around it.
- `NIH4` the worker's prompt carries the rule and the refusal-authority reminder, and goes on past a compaction.
- `NIH5` the generated prompts match their source: deleting one role's emitted line makes `--check` red.
- `NIH6` the prompts reach the agents: a root offered `subagent` and `principles` starts one child of each role, each child's model request carries its role's prompt, its finish-every-item line and the principle's name, and `principles` list and search answer principle-nothing-is-hard.
- `NIH8` each role's and the lean worker's model request carries its own role's prompt, and no other role's.

## How to get to it (user POV)

- An orchestrator starts a role agent: `subagent({ agent: "implementor", ... })` (also `planner`, `verifier`); an untyped or general call runs as `worker`. The prompt it runs on is `mods/orchestrate/agents.json`'s `system` for that agent.
- On Claude Code and Codex the same text is the dotfiles' `agents/<role>.md` and `codex/agents/<role>.toml`.

## Driving it with the world

- **Preconditions:** none.
- **States:** default only; the rest are `n/a` (a prompt has no loading, empty, refused or error state).
- **World suites:** `cmd/orchestrate/nothing-is-hard.sim.test.ts` (NIH6, NIH8), `cmd/orchestrate/orchestrator.sim.test.ts`, `cmd/orchestrate/orchestrate.sim.test.ts`
- **Code:** `mods/orchestrate/agents.json`, `mods/orchestrate/role.ts`, `scripts/agents.ts`
- **Regression:** `scripts/agents.test.ts` (`--check` red on an unregenerated source), `mods/orchestrate/role.test.ts` (each role and the worker go on after a compaction; agents.json decodes with every role), and from the dotfiles root `skills/orchestrate/scripts/agents.test.ts` (NIH1, NIH2 per role, each prompt within its size bound) and `skills/orchestrate/scripts/skill.test.ts` (the owner's kept rules in SKILL.md).

1. **NIH6.** `nothing-is-hard.sim.test.ts`: the default root is offered `subagent` and `principles`; both lookups answer the principle; the planner, implementor and verifier children's requests carry their prompts, the finish-every-item line and the principle's name.
2. **NIH8.** `nothing-is-hard.sim.test.ts`: a child of each role and the worker; each request's system carries its own role's prompt.
3. **NIH1, NIH4.** `orchestrator.sim.test.ts`: each role and the worker is defined with `agents.json`'s `system`, word for word.
4. **NIH1, NIH4.** `orchestrate.sim.test.ts`: the untyped call's requests carry the worker's prompt, the review call's the verifier's.
5. **NIH5.** `bun scripts/agents.ts --check` exits 0; remove the `principle-nothing-is-hard` sentence from `agents.json` and it exits 1 with `stale:`; `bun run agents` restores it.

`bun run verify:drive --feature nothing-is-hard-rule` runs those suites.

## Driving it with real OpenCode

- **Real:** `tests/orchestrate.test.ts` (each role's built prompt is the Claude Code agent's body word for word, and a real implementor's requests carry its prompt).

1. **Start a role.** Type `verify: call subagent {"agent":"implementor","description":"implementor alpha r1","prompt":"verify: say alpha ready"}`, Enter. Wait for `alpha ready`.
2. **Proof.** Snapshot after step 1 into `$EVIDENCE/nothing-is-hard-rule/`. The TUI does not show a request's system prompt: the Real check reads it from the requests the scripted model receives.

## Gotchas

- The prose's source is outside `opencode/`: the orchestrate skill's `protocol.md` and `SKILL.md` and the dotfiles' `agents/worker.md`. A change shows here only once `bun run agents` rewrites `agents.json`, which is this feature's Code.
- On the installed host the kernel plugin runs with `codeOnly` (its default): a model is offered `kernel` and the memory tools alone, and `subagent` and `principles` are lines in the kernel's description, called from a cell (`cmd/kernel/server.ts` line 145; the fork's `packages/core/src/tool.ts` `runtimeSnapshot`). A scripted model that looks for `subagent` or `principles` among a request's offered tools finds neither there; the world, which hosts no kernel (`kernel.md`), offers them directly.

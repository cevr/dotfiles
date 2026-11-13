# Orchestrate's machine and the land

A root that runs the orchestrate skill starts role agents (planner, implementor, verifier, worker) with the `subagent` tool, named in the skill's form (`<role> <unit> r<N>`), and the plugin holds it to the skill's batch machine at the point of action: a verifier not named `batch-<k>`, a second verifier while one runs, a land or verifier before the cadence, a land while a batch has no verdict, a land with a finding folded into no unit, and a land that leaves a ready unit out are refused in the skill's own words, with what to do instead. A batch lands through the rift tool's `land` (merge each Rift, one gate or the Rifts' receipts, one push), and its one verifier starts after. After a compaction the root is told the machine and its run's state.

## Sub-features

- `role-start`: a role call starts the role's agent on its model, its start and hand-back logged to the unit's `log.md`.
- `machine-refuse`: each of the six rules refuses in the skill's words (`VerifierPerUnit`, `VerifierRunning`, `BatchNotDue`, `VerdictPending`, `FindingUnfolded`, `LandPartial`).
- `machine-depart`: `(departs: <why>)` passes a refused call and records the departure.
- `machine-pipeline`: batch N+1's implementors start while batch N's verifier runs; its findings fold into the next starts.
- `machine-brief`: after a compaction, one steered brief of the machine and the run.
- `machine-move`: a root that moves between locations keeps one ledger.
- `land`: the rift tool's `land` merges a batch's Rifts, takes their receipts or runs one gate, pushes once, and trashes the Rifts.

## How to get to it (user POV)

- The root agent's `subagent` call with a role and a description in the skill's form.
- The rift tool's `{ "action": "land", "rifts": [...] }` (on the owner's machines only).
- A compaction of a root that runs units (the brief).

## Driving it with the world

- **Preconditions:** orchestrate loaded for one or two locations over one ledger; the roles' models answer as `machine-world.ts`'s steps say; the verifiers' reports are files the plugin's own reader reads, held in memory.
- **States:** default (a run that keeps the machine), refused (each rule), a compaction, a move between locations. Error is `cmd/orchestrate/orchestrate-faults.sim.test.ts`. Loading is `n/a`.
- **World suites:** `cmd/orchestrate/orchestrate-machine.sim.test.ts`, `cmd/orchestrate/orchestrate.sim.test.ts`, `cmd/orchestrate/orchestrate-faults.sim.test.ts`, `cmd/orchestrate/orchestrate-fallback.sim.test.ts`, `cmd/orchestrate/idle-root.sim.test.ts`
- **Code:** `mods/orchestrate/`, `cmd/orchestrate/`, `mods/rift/`, `cmd/rift/`, `sim/`
- **Regression:** `mods/orchestrate/machine.test.ts`, `mods/orchestrate/git/machine-words.test.ts` (the refusals held to SKILL.md).

1. **Drift after a compaction.** A root runs three implementors in the background, compacts while the third runs, asks for a verifier of one unit and a land of one Rift: both are refused in the skill's words; then it lands the batch and starts its one verifier, which passes.
2. **The pipeline.** Batch 2's implementors start while batch 1's verifier runs; its `changes` report opens findings that the next starts fold.
3. **Moves.** The root moves between two locations between its steps; each copy reads the other's ledger lines, and no keeping run is ever refused.

## Driving it with real OpenCode

- **Real:** `tests/orchestrate-machine.test.ts`, `tests/orchestrate.test.ts`, `tests/rift.test.ts`

1. **Hold a root to the machine.** Type `verify: call subagent {"agent":"implementor","description":"implementor alpha r1","prompt":"verify: say alpha ready","background":true}`, Enter. Wait for the call's answer; the implementor's row shows under the composer.
2. **A refused verifier.** Type `verify: call subagent {"agent":"verifier","description":"verifier alpha r1","prompt":"verify: say accepted"}`, Enter. Wait for `One verifier per batch`. The call is refused in the skill's words and names the `batch-<k>` form; no verifier session starts.
3. **A departure.** The same call with ` (departs: verify drive)` at the end of the description passes and starts the verifier.
4. **Proof.** Snapshot after steps 2 and 3 into `$EVIDENCE/orchestrate/`; the ledger is `$ROOT/home/.cache/orchestrate/machine.jsonl`, and its `Departed` line is the second view of step 3.

The land itself is never driven on a scratch server (`verify:seed` refuses the rift plugin, which lands real repositories): its proof is `tests/rift.test.ts` and the world's machine suites.

## Gotchas

- The machine holds a root only once it starts `implementor <unit> rN` agents; a root that runs no unit is never refused, so step 2 without step 1 passes and proves nothing.
- The refusal's words are SKILL.md's, through `bun run agents`; after a skill edit, `bun run agents --check` tells whether `agents.json` is stale.
- A Codex fallback never implements: a held implementor start latches and waits.

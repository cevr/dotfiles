# Orchestrate's tool and the land

A root that runs the orchestrate skill starts role agents (planner, implementor, verifier, worker) with the `subagent` tool, named in the skill's form (`<role> <unit> r<N>`), and moves its units with the `orchestrate` tool. The plugin keeps no batch machine: no call is refused for a batch rule, and every `orchestrate` answer is computed at the call from the run tables (the skill's `status.ts`, over the status RPC) and the warm source's Rift list, so a restart or another root gets the same answer. A land goes through the rift tool's `land` (merge each Rift, one gate or the Rifts' receipts, one push). After a compaction the root is told its status and the re-read.

## Sub-features

- `role-start`: a role call starts the role's agent on its model, its start and hand-back logged to the unit's `log.md`.
- `no-batch-refusal`: no call is refused for a batch rule: a verifier named for a unit, a second verifier while one runs, a land of one unit that just handed back, a land while a verifier runs, `(departs: …)` and `(folds: …)` all pass; only a subagent's `lane`/`land`/`verify`, a malformed input, the Sabbath, a latched child and a Codex implementor are refused.
- `stateless-restart`: after a restart, and from a new root session, `status` gives the same answer and a land of a unit the old root laned lands its Rift.
- `land-warn`: a land naming a unit the run tables show in another state than `ready` lands it, its answer starting `orchestrate: warning: <unit> is <state>, not ready; landed as asked.`
- `machine-brief`: after a compaction, a root that runs units gets one message: its `status` answer and the re-read.
- `land`: the rift tool's `land` merges a batch's Rifts, takes their receipts or runs one gate, pushes once, and trashes the Rifts. A gate its systemd scope stopped for memory is answered as out of memory at the scope's MemoryMax, not as a bare `exit 143`.
- `orchestrate-tool`: the root's `orchestrate` tool. It has four actions:
  - `lane` makes a unit's Rift, or answers the one that exists, ending `(rift: <path>)`; a Rift is never answered to another unit (`y`'s `feat-y` is not unit `feat-y`'s);
  - `land` lands the named units' Rifts (`{ unit, path }` as given), or with no units every unit the run tables show `ready` with a lane;
  - `verify` makes the verifier's clean checkout and answers the one subagent call that starts it;
  - `status` names each unit's state, its lane and one `next:` call.
- `derived-state`: a unit's state is its files and git, never kept: the skill's `status.ts <run dir> --repo <checkout>` prints `merged <head>` for a unit whose newest request's head is on the default branch (origin's, else `main`, else `master`), whatever its log says, `dropped` and the log's state otherwise, and a `Verdict` column (`changes r1`); merged and dropped units only with `--all`. The status mod reads each `orchestrate.dir` run beside `tmp/orchestrate/*`. After a land that pushed, each landed unit's log moves to `merged <commit>`.
- `verify-main`: `orchestrate({ action: "verify" })` with no batch verifies main from the last verified head (the newest batch file, `<run dir>/verify-*/batch-*.md` or `<run dir>/batch-<k>.md`, whose findings hold a verdict, its head the `Head:` line or else the `Heads:` line's dotfiles commit; with none, the fifth first-parent merge back) to origin's head: it writes `<run dir>/verify-main-<short>/batch-main-<short>.md` (`Base:`, `Head:`, `Heads:` with `fleet`, the merges, the units in the range) and answers `verifier batch-main-<short> r1`; an accepted verdict publishes the fleet target from that file (git/fleet.ts `batchFileOf`).
- `verify-due`: a land's and a status's answer start with `orchestrate: <N> lands on <branch> since the last verify (…): orchestrate({ action: "verify" }).` at 5 lands since the last verify, or one land once it is 24 h old (a land: a unit whose request head the range holds, merged or fast-forwarded, or a first-parent merge when those are more); and a land of a unit whose newest findings say `changes` (not older than its newest request) starts with `orchestrate: warning: <unit> lands with r<N>'s changes verdict open (<path>).` Neither refuses.
- `idle-root`: a root that ends its turn with nothing of its own going while units are in plan, implement or verify, or in `ready`, is steered once per idle period, with `idle with units in plan, implement or verify: …` or `… ready to land: …`. It is never steered while input it heard during the turn waits in its inbox (a prompt taken back or merged away no longer waits), while the owner drafts, while a question to him is open, or once it has a `waiting` queue item.

## How to get to it (user POV)

- The root agent's `subagent` call with a role and a description in the skill's form.
- The rift tool's `{ "action": "land", "rifts": [...] }` (on the owner's machines only).
- The root's `orchestrate` tool: `{ "action": "lane", "unit": "billing" }`, `{ "action": "land" }`, `{ "action": "verify" }`, `{ "action": "verify", "batch": "batch-7" }`, `{ "action": "status" }`.
- `bun ~/.claude/skills/orchestrate/scripts/status.ts <run dir> --repo <checkout> [--all]` in a shell.
- A compaction of a root that runs units (the note).

## Driving it with the world

- **Preconditions:** orchestrate, the real rift plugin on its memory layers and the status plugin loaded over one memory world of warm sources, Rifts and unit logs (`orch-tools-world.ts`); the status script prints the logs as its table.
- **States:** default (a run of lanes, starts, hand-backs and lands), a restart, a new root, a compaction. Error is `cmd/orchestrate/orchestrate-faults.sim.test.ts`. Loading is `n/a`.
- **World suites:** `cmd/orchestrate/orch-tools.sim.test.ts`, `cmd/orchestrate/batch-files.sim.test.ts`, `cmd/orchestrate/orchestrate.sim.test.ts`, `cmd/orchestrate/orchestrate-faults.sim.test.ts`, `cmd/orchestrate/orchestrate-fallback.sim.test.ts`, `cmd/orchestrate/idle-root.sim.test.ts`, `cmd/orchestrate/idle-root-property.sim.test.ts`, `cmd/orchestrate/orchestrate-latch.sim.test.ts`
- **Code:** `mods/orchestrate/`, `cmd/orchestrate/`, `mods/work/`, `cmd/rift/`, `sim/`, `mods/status/`, `cmd/status/` (the status plugin the world loads: the run tables, the pool pane's runs and agents), `scripts/agents.ts` (the role agents it makes), `tests/orchestrate.test.ts`, `tests/orchestrate/` (its real check)
- **Regression:** `mods/orchestrate/tools.test.ts` (the lane name rule, status and land resolution, B4's `next`, the due rule, the batch file's text), `mods/status/process/run-tables.test.ts` (B1: the real `status.ts` against a reference model over generated histories in a scratch repository; `orchestrate.dir` runs), `skills/orchestrate/scripts/status.test.ts` (B2, from the dotfiles root), `cmd/orchestrate/server.test.ts`, `cmd/rift/rpc.test.ts` (the rift plugin's RPC, which the `orchestrate` tool's lanes and lands go through).

1. **Nothing refused.** A1 of `orch-tools.sim.test.ts`: up to 16 seeded commands (lanes, starts with `(rift: …)`, `(folds: …)`, `(departs: …)`, verifiers named for a batch, a unit or `main-<sha>`, lands, verifies of a batch and of main, restarts, new roots, over a main that holds zero to six merges from before the run); no call fails but the model's own, each land reaches the rift plugin with the Rifts the model resolves, a verify of main's batch file has the model's base and the fleet's `Heads:` line, and `status` equals the model's rendering after every command, its due line first when the model's merge count says one is due.
2. **A restart and a new root.** A2: lane `a`, `a` hands back ready, a restart, a new root lands `a`.
3. **A warning, not a refusal.** A3: a land of a blocked and an implementing unit lands both, each warned first.
4. **Verify due.** B3 (`batch-files.sim.test.ts`; its changes-verdict half in `orch-tools.sim.test.ts`): main holds three merges from before the run, then two lands, restarts and new roots between them; status and the next land start with the due line (N = 5); `verify` writes the batch file from the fifth merge back with the units in range; a verdict beside it ends the warning; the next verify starts from that head. A land with an open `changes` verdict warns and lands, and its log moves to merged.
5. **A fast-forward land counts.** `batch-files.sim.test.ts`: after an accepted verify, five lands, the seed's pick of them fast-forwarded (no merge commit); the first four give no due line and the fifth gives `5 lands on main`.

## Driving it with real OpenCode

- **Real:** `tests/orchestrate.test.ts`, `tests/rift.test.ts`

1. **A verifier named for a unit.** Type `verify: call subagent {"agent":"implementor","description":"implementor alpha r1","prompt":"verify: say alpha ready","background":true}`, Enter. Wait for the call's answer; the implementor's row shows under the composer.
2. **It starts.** Type `verify: call subagent {"agent":"verifier","description":"verifier alpha r1","prompt":"verify: say accepted"}`, Enter. Wait for `accepted`. The verifier session starts; no answer says a batch rule.
3. **Status.** Type `verify: call orchestrate {"action":"status"}`, Enter. Wait for `orchestrate:`. The scratch checkout has no `tmp/orchestrate` run, so the answer is `orchestrate: no run of this repository holds a unit; …`, the same after a restart; it is not an error.
4. **Proof.** Snapshot after steps 2 and 3 into `$EVIDENCE/orchestrate/`; `$ROOT/home/.cache/orchestrate/` holds no ledger file.

The land itself is never driven on a scratch server (`verify:seed` refuses the rift plugin, which lands real repositories): its proof is `tests/rift.test.ts` and the world's `orch-tools` suite.

## Gotchas

- The run tables come from the status plugin of the repository's location; with no status plugin, or no `tmp/orchestrate/<run>` and no `orchestrate.dir`, `status` says no run holds a unit, a land with no units has nothing to land, and no verify is ever due.
- A unit merged by a squash (a PR repository) puts no request head on the default branch: it keeps its log's state until the root logs `merged`.
- `(departs: …)` and `(folds: …)` still parse in a description and mean nothing; `departs` still decodes in a land's input.
- A Codex fallback never implements: a held implementor start latches and waits.

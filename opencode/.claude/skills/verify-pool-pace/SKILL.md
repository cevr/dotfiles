---
name: verify-pool-pace
description: Verify account-local weekly admission with Quint and replay its generated traces against TypeScript. Use when changing weekly pace, eligibility, fleet start charging, reset rebasing, or request placement in the account pool.
---

# Verify weekly admission

An account that is spent or ahead of its own pace must not block another account with room. Otherwise a fresh week can be unusable until another account resets.

Run from `opencode/`:

```sh
bun scripts/verify-pool-pace.ts
```

The command requires Quint **0.34.0** and Java, uses Apalache **0.62.4**, checks ordinary admission by **one-transition closure over every integer usage, hour and fleet charge in its domain**, checks reset decisions through **eight transitions**, requires counterexamples from ten broken policies, then compares generated snapshots with the real `dispatchPace`, `decideClaim`, `hasRoom` and Fable `effectOf`. It keeps logs and ITF traces in `out/pool-pace/`. Quint may also write `_apalache-out/`; that is generated scratch, never a source artifact.

For a reset-only change after a complete admission run, `bun scripts/verify-pool-pace.ts --reset-only` reruns the reset proof and mutants, then replays both saved trace sets.

## Coverage

- `mods/pool/dynamic-pace.qnt`: two accounts, every usage unit from 0 to 16800, every hour from 0 to 168, every fleet charge from 0 to 1764; independent weekly resets, fresh/stale evidence, refusals, short-window/model limits, unsettled fleet starts, clock ticks, and observed natural resets. Known scheduled capacity uses 0, 0.5, 0.99, 1, 1.49 and 1.98 weekly units, with optional exhaustion deadlines at hours 24, 84 and 160.
- `mods/pool/reset-policy.qnt`: full Anthropic, Fable and Codex decisions, measured depletion, positive restoration, running and held work, the pool's other login (room, refused, stale or none: only room vetoes a refill for running work alone; held work always counts), pending claims, the 30-minute natural-reset boundary, 24-hour expiry and six-hour last call, Fable refund arithmetic, Codex clock restart, and repeated redemptions after fresh inventory.
- `mods/pool/weekly-pace.ts`: `lineOf`, positive-room aggregation, each account's ordinary eligibility, and catch-up scheduling.
- `mods/pool/pace.ts`: `budgetPace`, `poolPace`, `dispatchPace`, and the eligible login list.
- `mods/pool/dynamic-pace.test.ts`: the seven-account regression, unavailable-peer equivalence, ordinary placement, explicit pushes and fleet charges.
- `mods/pool/memory/model.test.ts`: a cached continuation moves to the admitted fresh account.
- `mods/pool/memory/launch.test.ts`: two host negotiation, frozen charges across restart, missing and old peers.
- `mods/pool/memory/launch-learning.test.ts`: whole-agent token costs update subsequent estimates, preserving the first completion across late binding and restart.
- `cmd/pool/pool-priority.sim.test.ts`: owner messages and compaction bypass soft weekly pace while hard quota binds.
- `cmd/pool/pool-reset-backed-pace-dispatch.sim.test.ts`: actual fake-provider requests use the fresh week, then stop when it is ahead of its own pace.

The initial admission fix is commit `627db4d97ef697ebcbf26a941937e3e50fda78dc`, verified through eight transitions before the reset extension. The reviewed reset implementation is commit `dd8c841141a33ceda637799499e9fabeba099650`; its model is introduced by the subsequent verification commit. Adaptive launch admission and root priority are synced to source commit `41cac70a`: ordinary charge replay includes frozen pending estimates plus the proposed worker, while priority and distributed agreement are explicitly covered by their seam tests. Full Quint verification passed, all eight mutants produced counterexamples, and omitting the candidate cost made the extended replay fail before restoration. After later changes, record the concrete reviewed source commit here only after confirming this coverage still describes it. Use `/maintain-formal-verification-skill` when the model and implementation drift.

## Properties and assumptions

The model checks that another account cannot cancel a solo admission, only accounts within their own pace are ordinarily eligible, fleet charges are covered once, one usable account follows its solo pace, and the final eight hours allow an otherwise usable account to reach the 99% safety target without pending start charges.

Quota units are `1/16800` of a week and time advances in hours. A model transition is an ordinary worker admission snapshot, not an atomic provider send. Its `charged` is the total of unsettled frozen launch estimates and the proposed launch. The trace replay supplies each total both as one legacy charge and as two heterogeneous pending costs plus a candidate cost. This checks candidate inclusion and frozen-cost arithmetic against the same independent model. The model does not prove the learned estimate predicts future work, nor the distributed lease, persistence or transport protocol; the launch seam tests cover those paths. Owner-facing root messages and compaction intentionally bypass the soft weekly line when hard quota remains. They are outside the model's ordinary `ownCycle` property; the priority pure and world tests cover this exception, its evidence requirements and hard limits. The trace adapter separately supplies reported windows to TypeScript. Sampling those traces checks implementation conformance; it is not exhaustive TypeScript verification. The ordinary admission model's initial state quantifies every integer usage, time and charge in its declared finite domain, with independent account evidence and scheduled stock. Every action constructs a new `snapshot`, retaining that domain; `start`/`settle` keep the charge bounds, `tick` clamps time at zero, `observe` stays inside the usage bounds, and `reset` restores a valid week. The one-transition check establishes the properties on every initial snapshot and closure after each action. This is an induction argument for that finite model, avoiding repeated SMT copies of a history-independent decision. The 24/84-hour urgency slopes divide the quota units exactly; the 160-hour urgency slope is below the paced line for every positive modeled stock value, so integer division does not change a decision. It does not prove arbitrary real-valued inputs. Reset decision checking remains bounded to eight transitions.

Demand, network availability and external consumers are unconstrained in reality: admission availability is not a guarantee that work consumes every quota. The admission model assumes the supplied stock is known and approved; it proves eligibility with scheduled capacity, not the inventory reader. Reset traces supply caller-ready options: absent credits and pending accounts yield none. They compare the actual pure rule and Fable refund; they exclude production candidate ranking, freshness filtering, leases, transport, persisted generation keys and refund reservations. Codex's new weekly deadline is the provider contract stated by the owner; the model records that assumption, rather than proving an external endpoint. Their existing checks are `mods/pool/admission.test.ts`, `mods/pool/reset-use.test.ts`, `mods/pool/reset-safety.test.ts`, and the pool's simulated journeys. Never describe a model pass as proof of those excluded paths.

## Read a failure

For the original pooled-debt counterexample, a fresh account is at zero usage while a peer is ahead of its own line. The fresh account starts alone but is held when the peer is included. `pooled_debt.itf.json` contains that witness. The other admission mutants admit an ahead-of-pace login, omit fleet charges, or ignore hard limits/evidence. Reset mutants claim at 85% on a forecast, clear unrelated shared usage on a Fable reset, pretend Codex keeps its cadence, allow only one redemption per weekly period, read room off a refused or stale login's reading (`room_on_reading`), or refill for running work beside a login with room (`room_blind`). The replay derives room from the model's other login through the real `hasRoom` and fails on any disagreement; it must see both a refill left for room and one made beside a refused or stale login (the `initRoom` traces make sure of both). Reading room off the reading alone in `hasRoom` fails the replay (`room mismatch`). Each must fail verification; a tool error does not count as a counterexample.

If Quint passes but replay fails, compare the supplied windows and the model's eligible set with the returned `dispatchPace` answer before changing either rule. Preserve the owner's requested invariants.

## Prove the guard still catches a real regression

In an isolated workspace, temporarily remove the zero clamp in `weekly-pace.ts`'s `roomAt`, so an ahead-of-pace account contributes negative room. Run:

```sh
bun scripts/verify-pool-pace.ts --replay-only
```

It must fail on the saved fresh-account witness. Restore that edit and rerun: it must pass. This mutation was run during the initial verification; `out/pool-pace/implementation-mutant.log` records the failure. Keep the mutation out of commits. Then run the normal repository gate and the pool drive described by `verify-opencode`.

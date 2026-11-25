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

The command requires Quint **0.34.0** and Java, uses Apalache **0.62.4**, checks the model through **eight transitions**, requires counterexamples from four broken policies, then compares generated snapshots with the real `dispatchPace`. It keeps logs and ITF traces in `out/pool-pace/`. Quint may also write `_apalache-out/`; that is generated scratch, never a source artifact.

## Coverage

- `mods/pool/dynamic-pace.qnt`: two accounts, usage partitions at zero, leeway, midweek, just below/at the weekly hold, and exhaustion; independent weekly resets, fresh/stale evidence, refusals, short-window/model limits, unsettled fleet starts, clock ticks, and observed natural resets.
- `mods/pool/weekly-pace.ts`: `lineOf`, positive-room aggregation, each account's ordinary eligibility, and catch-up scheduling.
- `mods/pool/pace.ts`: `budgetPace`, `poolPace`, `dispatchPace`, and the eligible login list.
- `mods/pool/dynamic-pace.test.ts`: the seven-account regression, unavailable-peer equivalence, ordinary placement, explicit pushes and fleet charges.
- `mods/pool/memory/model.test.ts`: a cached continuation moves to the admitted fresh account.
- `cmd/pool/pool-reset-backed-pace-dispatch.sim.test.ts`: actual fake-provider requests use the fresh week, then stop when it is ahead of its own pace.

The initial implementation is based on commit `249399c9cf70e8858f9219aaae920e54d9890c89`; its verified change is the commit introducing this skill. After later changes, record the concrete reviewed source commit here only after confirming this coverage still describes it. Use `/maintain-formal-verification-skill` when the model and implementation drift.

## Properties and assumptions

The model checks that another account cannot cancel a solo admission, only accounts within their own pace are ordinarily eligible, fleet charges are covered once, one usable account follows its solo pace, and the final eight hours allow an otherwise usable account to reach the 99% safety target without pending start charges.

Quota units are `1/16800` of a week and time advances in hours. A model transition is an admission snapshot, not an atomic provider send. The trace adapter separately supplies reported windows to TypeScript. Sampling those traces checks implementation conformance; it is not exhaustive TypeScript verification. The SMT result covers the model's partitions and eight-transition bound.

Demand, network availability and external consumers are unconstrained in reality: admission availability is not a guarantee that work consumes every quota. The ordinary model excludes usage-credit planning, claim transport, refunds and persisted refund reservations. Their existing checks are `mods/pool/admission.test.ts`, `mods/pool/reset-use.test.ts`, `mods/pool/reset-safety.test.ts`, and the pool's simulated journeys. Never describe a model pass as proof of those excluded paths.

## Read a failure

For the original pooled-debt counterexample, a fresh account is at zero usage while a peer is ahead of its own line. The fresh account starts alone but is held when the peer is included. `pooled_debt.itf.json` contains that witness. The other mutants admit an ahead-of-pace login, omit fleet charges, or ignore hard limits/evidence. Each must fail verification; a tool error does not count as a counterexample.

If Quint passes but replay fails, compare the supplied windows and the model's eligible set with the returned `dispatchPace` answer before changing either rule. Preserve the owner's requested invariants.

## Prove the guard still catches a real regression

In an isolated workspace, temporarily remove the zero clamp in `weekly-pace.ts`'s `roomAt`, so an ahead-of-pace account contributes negative room. Run:

```sh
bun scripts/verify-pool-pace.ts --replay-only
```

It must fail on the saved fresh-account witness. Restore that edit and rerun: it must pass. This mutation was run during the initial verification; `out/pool-pace/implementation-mutant.log` records the failure. Keep the mutation out of commits. Then run the normal repository gate and the pool drive described by `verify-opencode`.

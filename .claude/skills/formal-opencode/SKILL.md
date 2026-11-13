---
name: formal-opencode
description: "Formal check of the OpenCode mods' protocols, first the orchestrate batch machine's pipeline rule (a batch lands only once the batch before has its verdict, with every finding folded). A Quint model, run by `quint run` and `quint verify` (Apalache) and replayed through the real mods/orchestrate/machine.ts. Use when a change touches mods/orchestrate/machine.ts, the land/landed hooks (mods/orchestrate/model.ts `Machines.land`/`landed`, cmd/orchestrate/server.ts), or the rift land's claim (mods/rift/model.ts); when a verifier needs a receipt for such a change; or for \"model-check the machine\", \"formal check\", \"quint\"."
---

# Formal check of the OpenCode mods

One property is verified so far: the orchestrate machine's **pipeline rule**.

- **The property.** A batch lands only once the batch before it has its verdict, and only with every finding of that verdict folded into a unit the land takes, or into one still implementing or stopped (it rides with that unit's later land). SKILL.md of orchestrate, "The pipeline"; `RULES.VerdictPending` and `RULES.FindingUnfolded` in `opencode/mods/orchestrate/machine.ts`.
- **The harm.** A batch lands on top of an unverified one, or a finding a verifier proved is left behind, and main carries a known bug while the run believes it is fixed.

The check is a model of the machine and the world around it (implementors, one batch verifier, `rift` lands), in `opencode/formal/orchestrate/machine.qnt`. Its runs are replayed through the real `machine()`, so a pass speaks for the code, not only for the model.

## Does my change touch it?

Coverage record. The model describes these files and functions, as they were at the **sync commit `dbefc9cc`** (`SYNC` in `opencode/formal/check.ts`):

| File | What the model mirrors |
| --- | --- |
| `opencode/mods/orchestrate/machine.ts` | `decide` for `Start` (implementor, verifier), `HandBack`, `ReportRead`, `Land`, `Landed`, `Drop`; `evolve` for `UnitStarted`, `UnitHandedBack`, `BatchLanded`, `VerifierStarted`, `VerifierEnded`, `ReportResolved`, `FindingFolded`, `UnitDropped`; `named`, `unfoldedOf`, `holdsNoLand` (`riding`, `endedWith`), `verdictPending`, `coverOf`, `standInFindings`, `foldsOf`, `releasedBy` |
| `opencode/mods/orchestrate/model.ts` | `Machines.land` (one `ledger.decide`, the check) and `Machines.landed` (another, the record): two steps, not one |
| `opencode/cmd/orchestrate/server.ts` | a `rift` land's and an `orchestrate` land's `execute.before` hook calls `machines.land`, their `execute.after` hook `machines.landed` on a completed land |
| `opencode/mods/orchestrate/tools.ts` | `riftOfUnit`: the `orchestrate` land refuses a unit name the machine does not hold, before the machine decides (the `…Tool` steps) |
| `opencode/mods/rift/model.ts` | the land's claim of its integration Rift (`claimed`, `busy`): a second land while one runs is refused |

Each `ledger.decide` is one step of the model (one atomic step in the code, under the store's lock). `bun formal/check.ts` prints a note when a covered file changed since the sync commit.

Left out, by choice: `departs` (every call keeps the rules), `direct` units, time (the replay's cadence is 1 ready, so `BatchNotDue` never fires), `Spawned` and the reconcile of dead children (a dead child is a hand-back `none`), more than one repository, and Rift names (every land names `{ path, unit }`). Bounds: units `a`, `b`, `c`, one finding each, eight batch verifiers.

## Run it

From `opencode/` in your checkout:

```sh
bun formal/check.ts                     # typecheck, 4000 walks of 40 steps, replay of 200 traces (about 15 s)
bun formal/check.ts --mutants           # and prove it can fail: each mutant must be caught (about 1 min)
bun formal/check.ts --deep              # and Apalache: every run up to 8 steps, not a sample (about 1 min)
```

The tools are pinned: Quint `0.33.1` in `opencode/formal/package.json` (`bun install` puts it at `opencode/formal/node_modules/.bin/quint`); that Quint fetches its own evaluator and Apalache into `~/.quint` on first use, and Apalache needs Java 17 or later. The seed is fixed (`--seed 0x5eed`), so a rerun is the same run; `--seed <other>` explores other walks.

What it runs:

1. `quint typecheck` of the model.
2. `quint run` with `--invariant pipeline` and four witnesses: a second batch lands, a land carries a folded finding, a land refused by `VerdictPending`, one refused by `FindingUnfolded`. A witness reached 0 times is red: the walks never got where the property bites.
3. The replay (`opencode/formal/orchestrate/replay.ts`, the ITF decoded by `trace.ts`): every written trace, step by step, through the real `machine()`. The code must refuse what the model refuses, by the same rule, and hold the same state after each step.
4. `--deep`: `quint verify` (Apalache, a bounded model checker): `pipeline` in every run up to `--depth` steps (default 8; 12 runs past 20 minutes).
5. `--mutants`: three guards broken on purpose (`MUTANTS` in `check.ts`): the `VerdictPending` check, the `FindingUnfolded` check, and a dead verifier read as a verdict. Each is broken in a scratch copy of `machine.ts` (the replay must part from the model) and of the model (`pipeline` must break).

## Read the result

- `green`: the property held in every walk, the code followed the model on every replayed step, and (with `--mutants`) every mutant was caught.
- `RED: the pipeline rule breaks`: a walk broke the property. It prints the walk as numbered steps in the code's words (`implementor a hands back ready`, `the root calls rift land on a (Machines.land checks it)`, `the rift tool claims its integration Rift for a and merges`, then `PIPELINE BROKEN (VerdictMissing)` or `(FindingLeft)`), and whether machine.ts decides every step of it the same way. If it does, the bug is the code's: report it with that walk; do not weaken `pipeline` or the model until it passes. The trace stays in the scratch dir the message names.
- `RED: machine.ts parts from the model … at step N`: the code decided or folded a step otherwise than the model. Either the change broke a guard (a bug: the message says which rule the model expected), or it changed the machine on purpose and the model must follow (see Keep it in step). Read the diff of the step's function in `machine.ts` against the matching `pure def` in `machine.qnt` (each names its machine.ts function in its comment).
- `RED: quint verify …`: Apalache found a break within `--depth` steps; it prints the shortest one the same way. Any ITF trace (Apalache's `violation1.itf.json`, a kept run trace) reads as a story with `bun formal/orchestrate/story.ts <trace.itf.json>`.
- `RED: the walks never reached …`: the run is too short to prove anything there; raise `--samples` or `--steps`.
- `mutant … MISSED`: the check lost its teeth (a mutant's text is gone, or the property no longer sees the break): fix the check before trusting a green.

Read every result, a break's trace or a passing model, with the `/statechart` skill: it tells an invariant violation's shortest path in plain words, and draws how the machine moves between states when the check passes.

## A receipt for merge

A green check is a receipt for a change to the covered code, in place of the slow tests of the machine. In the change's Rift, from `opencode/`:

```sh
bun scripts/receipt.ts -- "bun formal/check.ts --mutants"
```

It runs the check and writes a `round` receipt naming the Rift's head and tree; a `rift` land by receipts takes it while they still match. A verifier that ran the check itself (at the batch head, `--deep --mutants`) attests it instead:

```sh
bun scripts/receipt.ts --attest "formal-opencode: bun formal/check.ts --deep --mutants green at <head>"
```

A receipt says nothing past the model's scope (above): a change to what the model leaves out still needs its own proof.

## Known findings

Three orders the machine does not check keep `pipeline` true; the check's `step` assumes the root keeps them, and each has its own step that drops the assumption and shows the break (`bun formal/check.ts --step <name>`):

- **F1 `stepVerifyEarly`**: a batch verifier started before its batch lands. The machine reads the start as a land by hand (`standInFindings`): its verdict takes the ready units out of the ledger, and their later `rift` land is "none of the machine's business".
- **F2 `stepLandAny`**: a land naming a unit the ledger does not hold as `ready` or `ended` (still `implement` because its hand-back was not read, landed already, dropped, or no unit of the run): `named` is empty, so the land passes every rule and `Landed` records nothing.
- **F3 `stepRestartLanding`**: a unit's next round starts, or the root drops it, while its land runs: `Landed` names units by what the ledger holds when the land ends, so the land goes unrecorded and the next land passes `VerdictPending`.

Each has a `…Tool` twin (`stepVerifyEarlyTool`, `stepLandAnyTool`, `stepRestartLandingTool`): the land goes through the `orchestrate` tool by unit names, which refuses a unit the machine does not hold. At `dbefc9cc` all three still break: the tool's refusal stops a land of a unit absent from the ledger, but a held unit in `implement`, `landed` or `verify` still lands with `named` empty (F2), a stand-in verifier's silent end leaves its units `landed` and landable that way (F1), and F3 is about the record, not the check.

When a fix lands for one, drop its assumption from `step` (the `free` argument of its action in `machine.qnt`), and keep its step as the regression.

## Keep it in step

- A change to a covered function that is meant: change the matching `pure def` in `machine.qnt` in the same branch, run `bun formal/check.ts --mutants` until green, and update `MUTANTS` when a mutated line moved.
- After you confirm the model describes the covered code at a new commit (read the diff of every covered file since `SYNC`), move `SYNC` in `opencode/formal/check.ts` and the sync commit above to that commit, in the same commit.
- Never move `SYNC` to silence the drift note without that reading.
- `/maintain-formal-verification-skill` brings this skill back in line after changes that did not recheck it.

## Next protocols

Each its own unit, one property each, the same shape (a `.qnt` beside a replay of the real module): the pool's login lease and release (`cmd/pool`, `mods/pool`), mail's exactly-once delivery across restarts (`mods/mail`), the wake latch (`mods/wake/latch.ts`), and rift land with receipts and locks (`mods/rift`).

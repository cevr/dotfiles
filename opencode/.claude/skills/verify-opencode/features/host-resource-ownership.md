# Host resource ownership

Admission publishes one current owner for a bound execution. A child that outlives its launcher can still be joined to that owner by its inherited descriptor and exact process birth. Work and Reclaim read the same holder revisions. Observations add measurements, not control or permission to act.

## Sub-features

- `single-bound-start`: one start per verified binding; lease, pin and holder commit together.
- `detached-owner`: a reparented child keeps its original owner without relying on PPID.
- `durable-holder-frontier`: enrolled owners can hand off work by revision and epoch; shared-cache borrowers remain distinct without multiplying the charge.
- `observation-only`: scanner JSONL can be replayed safely but cannot assert control, terminal state or proof.

## How to get to it (user POV)

- Run `host-admit host status --json` to get the current host, boot and scanner identity. Use `host-admit holder put --json` to submit bounded v1 observations; it is not an ownership-registration command.
- Run `host-admit holder list --json` to see the holder revision and rows. For an incomplete page, pass its `next` and original `revision` to `holder list --json --after-revision NEXT --snapshot REVISION`.
- A managed check started with `host-admit check run -- COMMAND …` publishes an execution holder under its existing lease. An enrolled launcher using authenticated session context can attach that context; a standalone check has no applicable OpenCode session, run, unit or job ID.

## Driving it with the world

- **Preconditions:** synthetic host, boot, supply and processes; a throwaway SQLite ledger and independent clients; no broker or workload.
- **States:** default = no owner; open = live bound scope; loading = granted but not bound; empty = n/a; refused = repeated binding; error = n/a.
- **World suites:** `cmd/guard/host-resources.sim.test.ts`
- **Code:** `cmd/guard/admission.ts`, `cmd/guard/host-admit.ts`, `cmd/guard/host-resources.sim.test.ts`, `mods/guard/admission.ts`, `mods/guard/admission-wire.ts`, `mods/guard/host-resources.ts`, `mods/guard/host-resources.test.ts`, `mods/guard/process/admission.ts`, `mods/guard/process/ownership.ts`, `mods/guard/process/ownership.test.ts`, `mods/guard/sqlite/admission.ts`, `mods/guard/sqlite/host-resources.test.ts`, `tests/host-admit-cli.test.ts`, `tests/host-check-leases.test.ts`

1. Grant offers to two independent callers. Offer the same native binding to both. Only the first caller gets a runnable lease; the second cannot launch.
2. Keep the first caller's child live after its parent changes to PID 1. Read from another journal connection. The child still joins to the live original session by inherited binding, not by PID or ancestry.
3. Read the same ownership fence on each client. A scanner can add an observation to the resource but cannot replace its controller or give it terminal proof.

## Driving it with real OpenCode

- **Real:** `tests/host-check-leases.test.ts`, `tests/host-admit-cli.test.ts`

The native detached-child journey starts its own gated descendant, observes that the original parent exited, checks the actual inherited descriptor and birth, then reads the same live owner through two reopened scratch journals. It releases the gate, waits on the OS exit witness and confirms that the descriptor drained. The standalone CLI journey uses multiple invocations to prove the same JSONL observation replays to the same revision and that forged terminal or duplicate-key input is rejected.

## Gotchas

- A read ref is not an actuator, even when it joins to a known owner. Missing or ambiguous evidence never establishes release.
- The holder API remains v1. The private SQLite writer format is v2. Downgrade does not rewrite state; an already-open older writer also cannot commit.
- Private path locators are never in holder rows or their exports. Renaming a locator does not change its native object identity or the holder revision.
- The process closed by the native test is its own scratch child, not a resident process. This is not a proof of independent Linux controller qualification or of a native OpenCode shell hook.

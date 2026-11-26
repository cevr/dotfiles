# Host check leases

A heavy check waits at its launcher until the host can admit it. Native shells, durable jobs and the standalone `host-admit` command use the same machine-local ledger; a shell permission request does not occupy capacity.

## Sub-features

- `shared-and-exclusive`: counted reservations and an exclusive frontier.
- `fresh-host-supply`: boot-local pressure and canonical volume checks.
- `fenced-launch`: one bound start, no release until the scope drains.
- `holder-observations`: replayable status and read-only ownership evidence.

## How to get to it (user POV)

- A classified shell command, or a job with `heavy: true`, takes admission at execution. `heavy: false` does not exempt a classified command.
- `host-admit host status --json` shows the caller, boot, managed limits, volume and controller; `host-admit check run -- COMMAND …` requests and runs a check.
- `host-admit lease request --json` accepts a v1 request. Use its ID with `lease status`, `lease watch`, `lease run` or `lease cancel`; requesting a lease does not authorize an exec elsewhere.
- `host-admit holder put --json` writes observations only. `host-admit holder list --json` returns a pinned, paged owner-and-use view.

## Driving it with the world

- **Preconditions:** scripted clock, supply and holders; no system load generated.
- **States:** default = idle supply; open = granted check; loading = queued under pressure; empty = no live holder; refused = stale identity; error = lost or unqualified scope.
- **World suites:** `cmd/guard/admission.sim.test.ts`, `cmd/wake/job-admission.sim.test.ts`
- **Code:** `mods/guard/admission.ts`, `mods/guard/admission-wire.ts`, `mods/guard/check-demand.ts`, `mods/guard/host-resources.ts`, `mods/guard/host-supply.ts`, `mods/guard/process/admission.ts`, `mods/guard/process/actuation.ts`, `mods/guard/process/launchers.ts`, `mods/guard/process/linux-controller.ts`, `mods/guard/process/terminal.ts`, `mods/guard/sqlite/admission.ts`, `mods/guard/memory/admission-acceptance.ts`, `cmd/guard/admission.ts`, `cmd/guard/host-admit.ts`, `mods/wake/job-admission.ts`, `mods/wake/job-admission.qnt`, `cmd/guard/admission.sim.test.ts`, `cmd/wake/job-admission.sim.test.ts`

1. Offer seven four-core checks to a 16-core host with six cores of noncritical outside demand and two protected cores. Two are granted; adding another core queues it.
2. Keep permission pending, then decline: there is no holder. Allow a different attempt, bind it and restart. A duplicate binding does not spawn again.
3. Retire its owner without proving scope exit. The next check still waits. Report scope exit under the right generation; the next check starts exactly once.
4. Run a heavy job with an unavailable host and with a disk below its floor. Neither starts a payload. A light job still starts, and `heavy: false` cannot exempt a classified command.
5. Read `host status --json`, then ask each offered class within its maxima on its `defaultVolume`: each is queued or granted, never refused (`mods/guard/process/status-admission.test.ts`). On a btrfs Linux host (the workbox) `capabilities.disk` is `measured`, and `check run --class check --width 1 -- /bin/true` exits 0; four parallel `sleep` checks on an unattested host run three at a time, the fourth starting when a holder ends. A refusal names its cause in `detail`.

## Driving it with real OpenCode

- **Real:** `tests/host-check-leases.test.ts`, `tests/host-admit-cli.test.ts`

The standalone client checks its v1 responses under scratch state. Use independent processes against the same throwaway journal to observe a held shared grant, an older exclusive request and a younger shared request. A restarted reader sees the same FIFO order. The Go, Bun, GNU Make and Ninja fixtures use stand-ins to check model-derived widths at the real claim; an unknown-width claimant takes the whole managed pool and its width-one successor runs only after drain. Impossible memory, volume and class demands and malformed widths are refused with no ticket. A real detached shell keeps the inherited lock after its launcher closes its copy; a separate Darwin fixture kills its own launcher and observes the group watchdog drop the lock without targeting a discovered PID. These tests run no build or workload.

For native terminal-owner reclaim, run the shared shell lifecycle law on the accepted fork prerequisite and matching dotfiles pair. Its platform proof must show authorization/bind ordering and recovery from an actual scratch OpenCode restart; the world fork double does not install or establish that capability.

## Gotchas

- No persisted grant permits launching a command directly. `lease run` revalidates supply and owns execution.
- Mac group signalling and scheduler limits are advisory. The inherited lock, not a group scan, proves its hold has ended. Linux requires both the lock and attested scope exit. A Mac test is not a Linux controller proof.
- A dead observer, missed delivery or live/unknown scope cannot authorize killing or releasing work.

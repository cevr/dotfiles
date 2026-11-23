# Host admission and holder protocol v1

One owner-private host SQLite WAL under the installed runtime's XDG state is authoritative for leases and holder revisions. Clients never open or copy it. Installed clients and plugins on one host use the same state directory across checkouts; scratch deployments choose a separate XDG root and do not coordinate with the installed host. The format, SQLite paths and native locator table are private. Files, paths, environment, argv, process IDs and cgroup names do not appear in wire replies. Opaque owner and containment IDs identify evidence, not capabilities.

## Noninteractive lease operations

`host-admit host status --json` returns the version, host/boot IDs, boot clock, scope and epoch of the authenticated local caller, the current working volume, and effective capabilities. IDs bind to the physical host and boot, not to directory names. Running a command does not create an OpenCode session.

`host-admit lease request --json` accepts one UTF-8 JSON object:

```json
{"version":1,"requestId":"checks-a","principal":{"kind":"external-runner","scopeId":"peer-fixture","epoch":1},"purpose":"check","tier":"standard","demand":{"cpuMilli":1000,"memoryBytes":1073741824,"ioClass":"idle","volumeReservations":[{"volumeId":"volume-fixture","bytes":0}],"keys":[]},"deadlineBootMs":50000}
```

Use the actual previously returned principal, volume and clock, not the example's values. The parent kernel process identity authenticates a standalone client's enrollment. The CLI rejects a different principal. Dedicated in-process launch authority is not accepted as JSON.

- `lease status --id ID --json`: current state.
- `lease watch --id ID --after SEQ --json`: replay available newer events as JSONL, or wait for a change.
- `lease run --id ID -- argv…`: revalidate, bind and run. Local argv is not persisted or sent to another host.
- `lease cancel --id ID --json`: withdraw before start, or request stop/drain of the owned attempt. No force release.
- `check run [--class CLASS] -- argv…`: local convenience request/wait/run with the same ledger and launch fence.

Replies contain v1, host/boot, ID, sequence, state, reason, sample ref, admitted demand and expiry. A missing or stale sample is a hold, not authority to run. Repeating the same scoped request and parameters preserves its ticket; a new attempt after terminal expiry gets a new ticket. A changed request under the same key is rejected. Claim and drain use the current generation and exact scope proof, not a PID or ownership assertion from stdin.

## Work classes and lifecycle

| Work | Class |
| --- | --- |
| Normal test/typecheck/build, including focused runs marked nice 19 | Shared; 1 core, 4 GiB. Niceness is not an exemption. |
| Traced inventory or deep recursive scan | Shared; 1 core, 2 GiB, idle IO, `trace` exclusive resource key. |
| Lima workload leg | Shared; 2 cores, 8 GiB, `vm` exclusive resource key. The launcher must own the actual long-running leg, not just the request that creates a daemon. |
| Gate or receipt that owns a whole exclusive suite | Exclusive; 1 core and 4 GiB profile, plus global exclusivity. Do not nest a second charged leaf under it. |
| Land accept and post-land checks | `land-check`, shared; 2 cores, 4 GiB. After the lifecycle barrier, acquire at the executing leaf. D owns migrating those call sites. |
| Bounded lease status, single-volume metadata and local liveness probes | Exempt from charging the check itself; no payload, deep traversal or builds in probes. |

Running reservations include draining work. A dead waiter is removed; a dead launcher with a still-live or unknown scope is not released. Liveness evidence records the owner ref and transition time. Resume on the same boot reopens durable tickets, not an independent pool. After a broker/server restart the same scope is reconciled; after a reboot its old ticket is stale.

Each bound attempt carries a private, inode-pinned flock across exec as descriptor 3. The launcher closes its own copy, never explicitly unlocks it; a new process proves release by acquiring the same lock on an independent open description. The kernel retains the lock while a descendant has a copy, even if it changes groups, execs or is reparented. A lost or replaced lock file is unknown, never empty. Linux additionally requires the exact service cgroup to be unpopulated or gone; systemd's control-group teardown reaches descendants that change process groups. On Darwin, the in-group watchdog arms only after the durable claim, owns no lease reference, and receives explicit stop or launcher death on a separate pipe. It signals its own group and escalates after two seconds. With no safe in-group authority, an escaped holder stays held; a bounded local descriptor scan reports positive holders and a local inspection command, not a raw-PID actuator. No raw PIDs, commands or local paths are emitted in v1 JSON. A program that deliberately drops inherited descriptors or requests a separate daemon falls outside descriptor attribution, not outside the whole-host supply measurements; Darwin does not guess ownership of that ambient load.

Mac samples whole-host Mach CPU ticks, active CPUs, runnable process states, pressure level, `memory_pressure -Q`, VM compressor/pageout/swap activity and canonical volume bytes/inodes. Its unverified declared CPU widths are charged at width squared. This is an advisory OS reservation with process-group, nice and taskpolicy placement, not a hard CPU or RAM guarantee. Linux uses host ticks, runnable counts, PSI, online/cpuset CPU and ancestor quotas, disposable transient services and verified workload/critical controller placement, and compares known applied scope counters from a coherent interval. Btrfs inodes are dynamic, so the metadata reserve is checked separately rather than treating a missing inode count as free. Unknown required measurements or unsupported confinement hold; raw load is not converted to available cores. Neither platform grants across its disk floor.

## Holder records

The published [`fixtures/holder-v1.json`](fixtures/holder-v1.json) is neutral cross-language input. All required fields are in `Holder`: identity/revision/kind; owner; relation and dependencies; placement and optional lease generation; separately nullable use measurements; observation timestamps and coverage; state/proof/protection; producer and sequence. `null` means unknown, never zero. Decimal safe nonnegative integers only; UTC milliseconds for display, boot-local monotonic milliseconds for freshness. Array sets are normalized and sorted; JSONL uses UTF-8, no duplicate object keys, and RFC 8785 canonical bytes for the restricted v1 payload. Reader-tolerated additive fields are non-authoritative. An incompatible major is rejected.

`holder put --json` takes a bounded JSONL batch, committing all or none. Local process identity binds its producer. A scanner must submit `relation:observation`, unknown owner/state/protection, null conformity/lease and no proof. Unknown or stated measurements do not confer control, terminal state, or actuation. Same normalized observation and producer sequence return the same revision; changes require the matching revision and the same resource incarnation. Controller rows are journaled by the arbiter, not clients.

`holder list --json` returns `{version,hostId,bootId,revision,complete,next,records}`. Continue with `--after-revision <next> --snapshot <revision>`; use the pinned revision so concurrent updates do not splice snapshots. An invalid watermark requires resnapshot. Incomplete pages never prove a full frontier. Copying/exporting a redacted record does not transfer its authority.

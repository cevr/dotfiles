# Host admission and holder protocol v1

One owner-private host SQLite WAL under the installed runtime's XDG state is authoritative for leases and holder revisions. Clients never open or copy it. Installed clients and plugins on one host use the same state directory across checkouts; scratch deployments choose a separate XDG root and do not coordinate with the installed host. The format, SQLite paths and native locator table are private. Files, paths, environment, argv, process IDs and cgroup names do not appear in wire replies. Opaque owner and containment IDs identify evidence, not capabilities.

## Noninteractive lease operations

`host-admit host status --json` returns the version, host/boot IDs, boot clock, scope and epoch of the authenticated local caller, the current working volume, and effective capabilities. IDs bind to the physical host and boot, not to directory names. Running a command does not create an OpenCode session.

`host-admit lease request --json` accepts one UTF-8 JSON object:

```json
{"version":1,"requestId":"checks-a","principal":{"kind":"external-runner","scopeId":"peer-fixture","epoch":1},"purpose":"check","tier":"standard","demand":{"width":1,"cpuMilli":1000,"memoryBytes":1073741824,"ioClass":"idle","volumeReservations":[{"volumeId":"volume-fixture","bytes":0}],"keys":[]},"deadlineBootMs":50000}
```

Use the actual previously returned principal, volume and clock, not the example's values. The parent kernel process identity authenticates a standalone client's enrollment. The CLI rejects a different principal. Dedicated in-process launch authority is not accepted as JSON.

- `lease status --id ID --json`: current state.
- `lease watch --id ID --after SEQ --json`: replay available newer events as JSONL, or wait for a change.
- `lease run --id ID -- argv…`: revalidate, bind and run. Local argv is not persisted or sent to another host.
- `lease cancel --id ID --json`: withdraw before start, or request stop/drain of the owned attempt. No force release.
- `check run [--class CLASS] [--width N|full|unknown] -- argv…`: local convenience request/wait/run with the same ledger and launch fence. On Darwin a width hint can increase demand but cannot override wider or unknown argv evidence. On qualified Linux a numeric declaration is charged and enforced by the scope's `cpu.max`, without inferring a tool bound.

Replies contain v1, host/boot, ID, sequence, state, reason, sample ref, admitted demand and expiry. Submission also returns the sampled CPU interval and pressure (or null if unavailable) that drove the decision. Width is a positive integer, `"full"` (explicitly unlimited), or `"unknown"` (missing or unverified bound, including older records). No model derives any dimension from a configuration file or default. Go test needs explicit `-p`, `GOMAXPROCS` and `-cpu`; if `GOENV=off` and `GOFLAGS` is unset, no hidden `-cpu` can change the explicit runtime bound. If `GOFLAGS` is not disabled or replaced by explicit package/CPU settings alone, hidden options can select another execution mode such as fuzzing, and the model stays Unknown. E.g. `GOENV=off GOMAXPROCS=4 go test -p 2` gives eight. Bun test takes its worker count from `--parallel=N`; GNU Make and Ninja take theirs from explicit positive `-j N`. Unknown width and explicitly unlimited width both charge the full managed pool. A full-pool reservation, including a clamped width, takes its FIFO turn when no CPU lease is outstanding and a fresh sample has at least half the managed pool free; it cannot borrow the protected reserve.

Classification and width use the same command parser. It follows supported wrappers and applies their environment changes in order, but launch always keeps the original argv. An option it does not understand stops the parse and cannot justify a narrower charge. See macOS `env(1)` and [GNU Coreutils `env`](https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html): the model accepts both spaced and compact short `-u` and `-C`, reset with `-i` or `-`, literal assignments, `--`, and simple literal `-S` strings. GNU long spellings are not assumed on macOS; split-string quoting, expansion, and unrecognized options are Unknown.

Memory and resource keys come from the same check-class profile on all three launch paths. One ceiling evaluator tests individually feasible demand at submission, then evaluates the same permanent ceilings and fresh supply against all granted, running and draining reservations at grant and claim. A per-request memory limit and shared host/controller memory limits are separate. Unsupported classes, missing volume or resource keys and memory/disk demand above a permanent ceiling return `refused` with a typed reason and `qualifiedForm`, without a ticket. A ticket made impossible by a changed envelope becomes terminal and stops fencing its peers. Temporary pressure or a stale sample on an attested host is a hold, not authority to run. Matching submissions preserve identity; claim and drain use the current generation and exact scope proof.

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

A foreground Darwin terminal is handed to the private launcher/payload group after the claim and restored without signaling the caller's group. Ctrl-C goes to the payload group; the launcher reports the observed payload status. Ctrl-Z leaves a charged `running` lease with reason `stopped`; SIGCONT/`fg` resumes the same attempt with no new grant. The independent watchdog ignores job-control stops and stays armed while a payload is stopped.

Each bound attempt carries a private, inode-pinned flock across exec as descriptor 3. The launcher closes its own copy, never explicitly unlocks it; a new process proves release by acquiring the same lock on an independent open description. The kernel retains the lock while a descendant has a copy, even if it changes groups, execs or is reparented. A lost or replaced lock file is unknown, never empty. Linux additionally requires the exact service cgroup to be unpopulated or gone; systemd's control-group teardown reaches descendants that change process groups. On Darwin, the in-group watchdog arms only after the durable claim, owns no lease reference, and receives explicit stop or launcher death on a separate pipe. It signals its own group and escalates after two seconds. With no safe in-group authority, an escaped holder stays held; a bounded local descriptor scan reports positive holders and a local inspection command, not a raw-PID actuator. No raw PIDs, commands or local paths are emitted in v1 JSON. A program that deliberately drops inherited descriptors or requests a separate daemon falls outside descriptor attribution, not outside the whole-host supply measurements; Darwin does not guess ownership of that ambient load.

For Ctrl-C in an owned foreground, the terminal already sent SIGINT. The launcher checks foreground ownership at delivery, not the cached stop/resume state. An exit in the four-second interrupt grace reports 130; only a still-running payload after that grace enters watchdog TERM then KILL. The descriptor/cgroup release rules are unchanged.

Mac samples whole-host Mach CPU ticks, active CPUs, runnable process states, pressure level, `memory_pressure -Q`, VM compressor/pageout/swap activity and canonical volume bytes/inodes. This is an advisory OS reservation with process-group, nice and taskpolicy placement, not a hard CPU or RAM guarantee. Linux uses host ticks, the current runnable count, PSI, memory and swap, online/cpuset CPU and ancestor quotas, disposable transient services and verified workload/critical controller placement, and compares known applied scope counters from a coherent interval. Btrfs inodes are dynamic, so the metadata reserve is checked separately rather than treating a missing inode count as free. An unattested controller is not an offered workload class; missing dynamic measurements cannot authorize execution. Raw load averages are not admission inputs on either platform. Neither platform grants across its disk floor.

## Holder records

The published [`fixtures/holder-v1.json`](fixtures/holder-v1.json) is neutral cross-language input. All required fields are in `Holder`: identity/revision/kind; owner; relation and dependencies; placement and optional lease generation; separately nullable use measurements; observation timestamps and coverage; state/proof/protection; producer and sequence. `null` means unknown, never zero. Decimal safe nonnegative integers only; UTC milliseconds for display, boot-local monotonic milliseconds for freshness. Array sets are normalized and sorted; JSONL uses UTF-8, no duplicate object keys, and RFC 8785 canonical bytes for the restricted v1 payload. Reader-tolerated additive fields are non-authoritative. An incompatible major is rejected.

`holder put --json` takes a bounded JSONL batch, committing all or none. Local process identity binds its producer. A scanner must submit `relation:observation`, unknown owner/state/protection, null conformity/lease and no proof. Unknown or stated measurements do not confer control, terminal state, or actuation. Same normalized observation and producer sequence return the same revision; changes require the matching revision and the same resource incarnation. Controller rows are journaled by the arbiter, not clients.

`holder list --json` returns `{version,hostId,bootId,revision,complete,next,records}`. Continue with `--after-revision <next> --snapshot <revision>`; use the pinned revision so concurrent updates do not splice snapshots. An invalid watermark requires resnapshot. Incomplete pages never prove a full frontier. Copying/exporting a redacted record does not transfer its authority.

# Why OpenCode freezes with many sessions (workbox, 2026-11-06)

Every claim carries **measured**, **inferred** or **guess**.

## Answer

- **What freezes is the TUI, not the server.**
  - The `bite-20590` TUI's main thread (`opencode -s ses_e56b9128…`, pid 2324482) ran at 80–88% of a core for whole recordings. It stayed at 90% or more for runs of up to 10 seconds. **measured**: rec_5c1dfe, rec_a6aefa, rec_959c95.
  - The server's main thread ran at 13% at the same time, with a peak of 317 ms of CPU in one second. **measured**: rec_3de643.
- **The TUI's time goes to JS that runs in promise continuations and reads Solid store proxies, not to drawing.**
  - The TUI spends 62–93% of its main thread in `drainMicrotasks`. **measured**
  - 23–25% of its main thread is inside `JSC::ProxyObject` (Solid's store proxies). **measured**
  - OpenTUI's native drawing and Yoga layout take 0.1–0.9% of it. Timers take only 2.4% in the worst window. **measured**
  - So while a freeze lasts, the microtask queue barely empties, and the render loop and input handling starve. **inferred**
- **Our TUI plugins' subagent rows grow with the family's size, and they run again for every streamed token.**
  - Replayed through the real `familyReader` and `subagents()` over a reactive Solid store, one token costs:
    - 3.1–5.1 ms with 170 children whose messages are not loaded;
    - 44 ms with 170 children of 100 messages each and one consumer;
    - 92 ms with the same family and three consumers.

    **measured**: `mods/subagents/solid/family.bench.ts`, Mac M-series.
  - The session tree has 171 sessions and 18,487 messages, with 8 children busy. **measured**: sqlite copy.
  - The TUI holds every message of each child created while the TUI runs (see fix 3). **inferred** from `packages/client/src/solid/data.ts` `session.created`.
  - Whether our rows are the larger share of the 80–88% next to the core's own transcript memos is **not yet measured**. Strobe cannot name the JIT frames of a running compiled Bun (see "Next step").
- **Load on the machine adds to it but is not the cause.**
  - At 18:55, load was 16–22 on 16 vCPUs and 529 MB of RAM was free. A `bun test` (pid 2342223, `client/…/checkout-back.test.tsx`) held 42 GB of RSS. **measured**
  - Pressure stall: memory some 2.9%, io full 9.5%, cpu some 10–18%. **measured**
  - The freezes at 19:07 and 19:08 came at load 5 with 7 GB free and look the same. So the TUI is CPU-bound by itself. **measured**: rec_a6aefa, rec_959c95.

## Evidence

The setup:

- Strobe 0.14.0 ran `record pid:<n> --probes deep` (perf_event user stacks at 1 ms). `kernel.perf_event_paranoid` was already 2, so no sysctl change was needed.
- Strobe resolves only 0.2% of the samples, because the binary is stripped and the JIT frames have no names. A `bun build --compile` binary shares `.text` with the Bun release of the same version (GNU build id `588d7307…` for both). So `scripts/perf/strobe-symbolize.py` symbolizes the samples with Bun 1.4.4's `bun-linux-x64-profile`.
- Per-second CPU comes from `scripts/perf/strobe-timeline.py`.

| Recording | Target | Window (UTC) | Main thread | Seconds ≥90% busy | Microtasks | Store proxies | Timers | OpenTUI native |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rec_5c1dfe | bite-20590 TUI | 18:55:28 +60 s | 88% | 34/61 (run of 10) | 92.9% | 25.4% | 2.4% | 0.1% |
| rec_52c852 | bite-20590 TUI | 19:02 +60 s | 24% | 0/61 | 28.9% | 7.9% | 46.8% | 12.4% |
| rec_a6aefa | bite-20590 TUI | 19:07:35 +30 s (caught at >80%) | 80% | 12/31 (run of 8) | 62.2% | 22.9% | 29.3% | 0.9% |
| rec_959c95 | bite-20590 TUI | 19:08:15 +30 s (caught at >80%) | 81% | 12/31 | 70.8% | 23.1% | 21.2% | 0.4% |
| rec_7b5a13 | ses_e56b984c TUI (26 sessions) | 19:02 +60 s | 17% | 0/61 | 34.2% | 17.0% | 45.1% | 4.5% |
| rec_3de643 | server | 18:57 +60 s | 13% | 0/61 | 24.8% | 0.0% | 13.1% | n/a |

The percentages are inclusive shares of the process's samples, and categories overlap.

The bite-20590 TUI in its busy windows (rec_5c1dfe):

- 96% of the process's CPU is on the main thread; GC helpers take 2.4%.
- 64% of the samples have a JIT frame as the leaf (JS).
- The top runtime leaves are:
  - `operationGetByValGeneric` (4.5% self, 28.9% inclusive): `obj[key]` on a proxy;
  - `JSObject::hasProperty` from `opInByVal` (4.0% inclusive): `in` on a store target, Solid's `has` trap;
  - `ProxyObject::getHandlerTrap` and `getOwnPropertySlotCommon`;
  - `globalFuncCopyDataProperties` and `globalFuncCloneObject` (object spread);
  - `putDirectInternal` (object literals).
- JSON parse takes 0.0% and sqlite 0.0%. **measured**
- So the cost is not decoding events. It is the computation that each store write sets off. **inferred**

The server (rec_3de643, its own pid only):

- 0.20 cores in total.
- The main thread takes 68% of that, the JIT worker 12%, and mimalloc's scavenger 9.8%.
- Self time: `mi_page_purge_holes_now` 5.8%, sqlite 2.8% inclusive, HTTP request parsing 14% inclusive. **measured**
- The server is not where the freeze comes from. **measured**

Other baselines (pid 2314015 is the server, pid 2324482 the bite-20590 TUI):

| Measure | Server (2314015) | bite-20590 TUI (2324482) |
| --- | --- | --- |
| VmHWM | 4.22 GB, reached in its first 10 minutes after a restart (the brief said 5–6 GB before that restart) | 891 MB |
| RSS | 680 → 755 MB | 685 → 815 MB in 12 minutes (its store grows) |
| Open fds | 120–123 | 15–25 |
| Threads | 33 | 20 |

All of these are **measured**. The sqlite WAL is 181 MB and the database 663 MB. **measured**

CPU per TUI follows the activity of its own session tree. The figures are from `/proc` every 5 s, 18:58–19:03 (`scripts/perf/cpu-timeline.sh`), and the messages are those of the last 10 minutes. All **measured**.

| TUI session | Sessions in tree | Messages in tree | Recent messages | TUI CPU |
| --- | --- | --- | --- | --- |
| bite-20590 `e56b9128` | 171 | 18,487 | 328 | 15–65% |
| `e56b984c` | 26 | 4,117 | 101 | 7–35% |
| `e56ba5bf` (ergo) | 112 | 11,122 | 6 | 4–51% in bursts |
| `e56b9f69` | 27 | 3,194 | 36 | 3–10% |
| `e56bb6de` | 1 | 286 | 4 | 1–5% |

## Our plugins' share (the replay)

`bun --conditions=browser mods/subagents/solid/family.bench.ts <children> <messages per child> <consumers>` replays the subagent rows over a store shaped like the TUI's data. A consumer is one computation that reads the family and its rows: prime's dock count (`working()`), prime's rows (`SubagentRows`) and the queue's sidebar each are one. Each calls `read` itself, because `host.subagents()` is not shared. The root has 300 messages. All figures are **measured** on a Mac M-series with Bun 1.4.4.

| Children | Messages per child | Consumers | First read | Per token |
| --- | --- | --- | --- | --- |
| 8 | 100 | 3 | 79 ms | 6.0 ms |
| 20 | 100 | 3 | 162 ms | 10.4 ms |
| 170 | 0 | 1 | 17 ms | 3.5 ms |
| 170 | 0 | 3 | 25 ms | 3.1–5.1 ms |
| 170 | 20 | 1 | 213 ms | 7.9 ms |
| 170 | 100 | 1 | 789 ms | 44 ms |
| 170 | 100 | 3 | 1,334 ms | 92 ms |

Where the time goes in the 170 × 100 × 3 case (`bun --cpu-prof`, `scripts/perf/cpuprofile-top.py`):

- 41% in `lastHeard`, `activity.ts:196`. Every row flat-maps every message and part of its session, on every token.
- 40% in `read` / `session`, `view.ts:190–230`. `items.flatMap(convert)` re-reads every item's memo for every session, on every token.
- 24% in `launch`, `subagent-row.ts:116`, in the case with no child messages. Each of the 170 rows scans all of the root's messages for its launch call.

## Fixes, ranked

1. **Read the family once per root, not once per consumer.** Our plugins (prime, queue), small.
   - `prime/opencode/host.ts` `subagents()` builds a new `read` for each caller.
   - Keep one memo per root session in the TUI process, shared by prime's dock and rows and the queue's sidebar.
   - Expected: ÷2–3 of our per-token cost, 92 → about 44 ms at 170 × 100. **measured** by bench (consumers 3 → 1).
2. **Make the family read and the rows incremental per session.** Our plugins (subagents), medium.
   - Give each session its own memo in `familyReader`, so a token in one child rebuilds only that child's `Session` and the family keeps the other objects.
   - Keep per-`Message` values in WeakMaps: `lastHeard`, the agent, the step count, and the launch call by child id from the parent's messages.
   - The rows then cost O(children) per token instead of O(all messages in the family).
   - Expected: most of the remaining 44 ms. About 80% of the profile is these O(total) walks, so roughly 1–5 ms per token is left. **guess**, to be measured with the same bench.
3. **Bound what a TUI keeps of sessions it does not show.** Core (fork), `packages/client/src/solid/data.ts`.
   - On `session.created`, the client marks `session.message:<id>` complete, so live events build that child's whole transcript in the store, without a bound.
   - Keep the newest page for sessions off screen, or drop message bodies of children that have finished.
   - Expected: it bounds the TUI's RSS, which grew 130 MB in 12 minutes (**measured**), and every O(messages) walk, both core's and ours. **inferred**
4. **Coalesce store writes per frame.** Core (fork), event handling in `data.ts`.
   - Each event (each token delta) is its own `setStore`, followed by a synchronous Solid update in a microtask.
   - Batching all deltas that arrive within one frame (16–33 ms) into one `batch()` turns N recomputes into one per frame.
   - It also lets timers (render, input) run between batches, which is the "freeze" the owner feels.
   - Expected: large under bursts. The recompute count drops from tokens/s to ≤ 30–60/s. **inferred**
5. **Subscribe a TUI only to its own family's events.** Core (fork), `/api/event`.
   - Today the stream sends "events across all server locations", filtered only by type, so every TUI handles every session's token deltas.
   - Add a filter by session or root and use it from the TUI.
   - Expected: each TUI stops paying for the other four TUIs' and the headless sessions' traffic. I did not measure the stream: it needs the server's credential, which I did not read.
6. **The machine.** Owner's choice.
   - A tool-run `bun test` reached 42 GB of RSS and pushed the box into swap.
   - A `MemoryMax` like the `systemd-run -p MemoryMax=8G` wrapper some runs already use would keep one test from slowing every TUI.
   - Expected: smaller freezes under load, not the root cause. **inferred**
7. **Server allocator purge.** Core, low priority.
   - mimalloc's purge and scavenger take about 15% of the server's 0.2 cores.
   - Expected: small. **guess**

Fixes 1 and 2 are done in this branch (`mods/subagents/solid/reader.ts`, `subagent-row.ts`, `activity.ts`, `works.ts`). The bench, 170 children × 100 messages, three consumers, one token, same Mac at load 11–14, its views checking that each sees the token: 90–153 ms before, 1.0–1.6 ms after; one consumer 34 ms before, 0.7–2.1 ms after. **measured** The JS profile of the frozen TUI later put `mods/prime/tui/live.tsx` at 22%, `mods/subagents/opencode/view.ts` at 11%, `mods/prime/tui/chrome.tsx` at 8% and `subagent-row.ts` at 3% of its time, all of which read the family through this path. **measured** by the orchestrator's profile `cpu-2324482-2026-11-06T191154973Z.cpuprofile`.

Fix 3 is done on the fork's `perf-upstream` branch (`f160ee31e0`, on a merge of upstream `dev` at `ec53c3b3cb`): inside a retained family, a subagent idle for 5 minutes drops its loaded transcript unless it is shown, an ancestor of the shown session, running, or waiting on a shell or subagent of its own (`createSessionRetention`'s `idle` option, `packages/client/src/solid/retention.ts`); opening it reloads its newest page. Bench (`packages/tui/test/context/session-retention.bench.ts`, 170 finished subagents × 100 rows of 2 kB): heap 41.5 → 2.5 MB over baseline, a walk over the family's loaded rows 6.3 → 0.15 ms. **measured** Fix 4 was already in core: the client applies events in one `batch()` per 10 ms window (`publish` in `packages/client/src/solid/connection.ts`). **measured** by reading the code. Fix 5 is not taken: the profile puts JSON parse at 0.0%, and the client drops an event for a session it has not loaded with one map lookup (`editAssistant`). **inferred**

## Next step: name the JS (one action by the owner)

The running fork (`2d74252c`, `packages/cli/src/cpu-profile.ts`) writes a 10 s JS CPU profile when it gets `SIGPROF`.

1. While the bite-20590 TUI freezes, run `kill -PROF <its pid>` on the workbox. The pid was 2324482 at this writing.
2. The profile lands in `~/.local/share/opencode/log/cpu-<pid>-*.cpuprofile`.
3. `python3 opencode/scripts/perf/cpuprofile-top.py <file>` then splits the time by function and file: core `packages/tui`/`client` against `mods/subagents`, `mods/prime`, `mods/queue`.

That decides between fixes 1–2 (ours) and 3–4 (core) first. The worker protocol forbids me to signal a process I did not start.

## Strobe

- **Health.** 0.14.0 is pre-release. It ships as npm `@hona/strobe` with platform packages; there are no GitHub releases.
  - It went from 0.6 to 0.14 in about a week. The repository was created on 2026-10-31.
  - It has 114 stars and about 100 commits in the last month, the last on 2026-11-07. It has no license file.
- **What worked.**
  - `record pid:` with deep probes on a live process: no restart, about 1–2% of samples lost (1,865 of 56k events). **measured**
  - `strobe status` named the permission state.
- **What did not.**
  - On a compiled Bun binary it resolves only 0.2% of the samples, and it does not read a symbol file of another binary. `scripts/perf/strobe-symbolize.py` fills that gap.
  - JIT frames stay unnamed: the `bun:<port>` inspector target is not built.
  - `query <rec> threads` failed: `trace_processor` cannot mmap, and a deep record writes no `trace.pftrace`.
  - `record pid:` samples the whole process tree. On the server that meant 58 tool processes, which the script filters out with `--pid`.

## Installed on the workbox (remove when done)

- `~/.local/opt/strobe-0.14.0/` (14 MB): the strobe binary from the npm tarball. I did not run `strobe up`, so there is no daemon, autostart or skill.
- `~/.local/opt/bun-1.4.4-profile/` (696 MB): Bun's symbol build and its `.nm` cache.
- `~/.local/share/strobe/` (24 MB): the recordings above.
- `/tmp/opencode/perf-freeze/`: scratch with the scripts, timelines and the freeze-catch log.
- No system package was installed and no sysctl was changed.

These were removed after that run.

# Under load (workbox, 2026-11-08 00:26–00:46 UTC)

The machine: load 39/34/22 on 16 vCPUs at the start, CPU pressure `some` avg60 53%, then 13–22 while recording. Nearly all of it was Go builds and tests at nice 0 from five `systemd-run --user --wait --pipe` units the ergo verifiers started (about 12 cores); see "Who ran the Go work". **measured**

## What it says

- **OpenCode is not where the load is, and the TUIs did not freeze.** No recording had a single second with the main thread ≥90% busy. **measured**
  - Server: 0.23–0.24 cores over the whole process, its main thread at 17% on average, peaking at 642 ms in one second.
  - The busiest TUIs: 0.03–0.09 cores, main thread 2–6% on average.
  - Before the fixes above, the bite-20590 TUI ran at 80–88% for whole minutes. The workbox's server and TUIs restarted at about 00:30 during this run, so this is not a like-for-like bench of fixes 1–3. **inferred**
- **An idle TUI's time is its timers and the allocator, not its store.**
  - Timers are 38–50% of the TUI's samples, and OpenTUI's native render and Yoga layout 5–13%.
  - Solid's store proxies are 3–4% (23–25% in the frozen TUI), and the microtask drain 10–38% (62–93%).
  - mimalloc's purge (`mi_page_purge_holes_now`, `mi_arena_page_purge_holes_at`, `_mi_thread_idle_work`, the `mi-scavenger` thread) takes 10–21% of each TUI's samples. **measured**
- **The server's split is the same as on 2026-11-06, a little larger.** Microtasks 30–31%, timers 14–15%, socket and HTTP 8–10%, GC on the main thread 11–12%, sqlite 5%, JSON stringify 4–5% (`appendQuotedJSONString` alone is 2.8–3.6% self), mimalloc purge and idle work about 9% self, the JIT worker 7–10%. On 2026-11-06 it was 0.20 cores with sqlite at 2.8% and HTTP at 14%. **measured**
- **The JS is still unnamed.** 26–35% of the samples have a JIT frame as the leaf, and strobe 0.19 names none of them, the same gap as 0.14. A per-file split of the JS needs the fork's `SIGPROF` profile (`cpuprofile-top.py`), which only the owner may trigger (see "Next step"). **measured**

| Recording | Target | Window (UTC) | Cores, whole process | Main thread mean | Microtasks | Timers | Store proxies | GC (main) | mimalloc purge, self | OpenTUI native | JSON stringify | sqlite |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rec_75a20e | server (old pid 3621862) | 00:26:47 +180 s | 0.23 | 17% | 31.3% | 14.2% | 0.0% | 11.9% | 6.6% | n/a | 3.9% | 5.0% |
| rec_95fc3f | TUI `e56b9f69` (old) | 00:29:47 +180 s | 0.03 | 2% | 38.4% | 9.1% | 2.6% | 7.2% | 8.0% | 5.4% | 0.0% | n/a |
| rec_7df7ae | server (new pid 2660982) | 00:38:51 +150 s | 0.24 | 17% | 30.1% | 15.0% | 0.0% | 11.4% | 5.1% | n/a | 5.0% | 5.2% |
| rec_444ab7 | TUI `e56ba5bf` (ergo) | 00:41:24 +150 s | 0.09 | 6% | 10.0% | 49.8% | 3.8% | 9.0% | 11.9% | 8.3% | 0.1% | n/a |
| rec_15594d | TUI `e56b9128` (bite) | 00:43:54 +150 s | 0.04 | 3% | 14.4% | 38.4% | 4.1% | 8.0% | 18.2% | 12.7% | 0.1% | n/a |

The workbox's server and TUIs restarted at about 00:30:30 (not by this run): rec_95fc3f's TUI ended 49 s into its recording, and the second old TUI (`e56bb6de`, pid 2446308) was gone before its turn, so the three later recordings are of the new processes, 8–13 minutes old. Shares are inclusive of the process's samples, from `scripts/perf/strobe-symbolize.py` with Bun 1.4.4's profile build (same build id `588d7307…`); per-second CPU from `strobe-timeline.py`.

## Worth fixing, in order

1. **Nothing urgent on OpenCode's side.** Under load 20–39 the whole of OpenCode took under half a core: the server 0.24 and five TUIs about 0.03–0.1 each. The load is the Go units; the guard fix below is the fix that matters. **measured**
2. **The idle TUIs' timers.** 38–50% of an idle TUI is timer callbacks. Which timers is unknown until the JS is named: prime's dock and spinners, the subagent rows' clocks and OpenTUI's own frame timer are the candidates. Plugin first: a timer that runs while nothing on screen changes is ours to stop. To confirm with one `SIGPROF` profile of an idle TUI. **guess**
3. **mimalloc's purge in every Bun process.** 10–21% of a TUI's samples and about 9% of the server's go to returning freed pages to the OS. mimalloc reads `MIMALLOC_PURGE_DELAY` from the environment (ms, default 10; `-1` never purges, at the cost of RSS), if Bun's build keeps its environment options (not checked), so `~/.local/bin/opencode` could export a longer delay, like 1000, for the TUIs. It would save a few percent of a core over the five TUIs: small, and cheap to measure with one strobe recording before and after. **guess**
4. **The server's JSON stringify (4–5%) and GC (11–12%).** Likely one `JSON.stringify` per event per subscriber on the event stream, and the transcript objects it builds. Core (fork). Not worth it at 0.24 cores. **inferred**

## The Mac (2026-11-08 00:39–00:43 UTC)

- strobe 0.19.0 runs on macOS (`@hona/strobe-darwin-arm64`, in `~/.local/opt/strobe-0.19.0/`): `record pid: --probes deep` samples with `/usr/bin/sample`, untimed. Load was 5–7 on 12 cores, after a restart of the Mac's server at 00:38.
- rec_944687, the server (pid 71887): 11,545 samples in 120 s, about 0.1 cores. rec_b94bf2, the busiest TUI (pid 72117, `ses_e56d092f`): 2,213 samples, about 0.02 cores. **measured**
- strobe names no frame of the compiled binary there (`_mh_execute_header` 67–85%, `???` 12–21%): the Mach-O is stripped, and `strobe-symbolize.py` reads ELF only. Symbolizing it would need Bun's darwin profile build and a Mach-O path in the script; at these loads it is not worth it. The only named leaf was Yoga's `roundLayoutResultsToPixelGrid`, 1.8% of the TUI. **measured**
- This session's own TUI was not singled out: a subagent cannot tell which TUI shows its parent. The busiest one stood in for it. The script's `pgrep -f` also skips the server, because macOS `pgrep` leaves out the caller's ancestors, so the server was recorded by its pid.

## Who ran the Go work

Matched by each unit's `GOCACHE` and working directory against the shell calls in a read-only copy of the server's database (`session_message`). **measured**

| Unit | Started (UTC) | What | Session |
| --- | --- | --- | --- |
| run-u33984 | 00:14:11 | `go test -p 4 ./internal/sketch/check` then `lower`, in `/tmp/opencode/v-s1a-head` | `ses_e478202fcffe63EiL6994OB9eo` "verify S1A" |
| run-u33988 | 00:14:25 | `go test … TestEveryPackageRecordsOnlyItsClosure ./internal/closure`, which builds every package itself, in `~/Developer/personal/.worktrees/ergo-b9-fix-gate` | `ses_e47f86a97ffepOeUwOAopwXDhZ` "b9 fix gate F2 F3", through `flock … sh batch4.sh` (the `systemd-run` sits in the script) |
| run-u33993 | 00:15:26 | `go test ./runtime/... ./internal/sketch/{std,check,lower}`, in `/tmp/opencode/v-s3a-head` | `ses_e477f03c7ffec0txt8kz5O0h80` "verify S3A" |
| run-u33996 | 00:16:05 | `go test ./runtime/v1 ./internal/sketch/{std,check,lower}`, in `/tmp/opencode/v-s3b-head` | `ses_e477f03afffezb5lJsJ1K7A7I8` "verify S3B" |
| run-u34014 | about 00:19:50 | `go test ./internal/sketch/check`, in `/tmp/opencode/v-s1b-head` | `ses_e478202e6ffeD49Bogo0OKPvHT` "verify S1B" |

All five are children of the ergo root session `ses_e56ba5bf2ffeEzZPXNSBA6bBSm` ("Session handoff to OpenCode, resuming agents"). Each took a verify-slot `flock` and ran `systemd-run --user --wait --pipe --collect --same-dir -q -p MemoryMax=8G -p MemorySwapMax=0 … env GOMEMLIMIT=6GiB GOMAXPROCS=4 … timeout N go test …`. So memory was capped, but `GOMAXPROCS=4` with `-p 4` is up to 4 processes of 4 threads each, not 4 threads (**inferred** from Go's build and test scheduling), and every unit ran at nice 0 and the default CPU weight, next to the TUIs. A service started this way leaves the guard's launcher: measured on the workbox, `nice -n 10 systemd-run --user --scope … sh -c "systemd-run --user --wait --pipe …"` runs the inner command at nice 0 in its own service cgroup, and an inner `--scope` keeps nice 10 but leaves the launcher's `CPUWeight=20` scope.

Why they ran at once: the run's orchestrator wrote it. The wf10 `common.md` it gave every worker says "Run every Go command under `systemd-run --user --scope -p MemoryMax=8G …`" and, for tests that start processes and mutants, service mode (`systemd-run --user --wait --pipe --collect …`), after an orphaned mutant filled the disk. Its verify briefs gave each verifier its own lock, `verify-slot-${k%4}` ("shared slots cap concurrent verifier runs"), and benchmarks and the fix implementor's runs took `gate.lock`: five lanes at once, each sized `GOMAXPROCS=4 -p 4`. Its Waves rule says "The verifiers for the wave start together at its end, one per unit". **measured** from `~/.cache/baton/wf10/common.md`, the verify briefs and the root session's kernel cells. The orchestrate skill then set no limit on heavy checks per machine, only a load check when an agent starts. **measured** by reading `SKILL.md`.

A guard `systemd-run` shim that gave such units the launcher's limits was tried on 2026-11-08 and removed the same day: it worked on systemd hosts only, and a lower priority on every lane does not stop five lanes from asking for 80 threads on 16 cores. The fix is in the orchestrate skill instead ("Heavy checks fit the machine"; `protocol.md`, Shell): the orchestrator sizes the threads of all heavy checks on a machine to its cores, and workers never wrap a check in a unit of their own. The guard reads Go and Rust builds as heavy, through `flock`, `env` and the like, but not through `systemd-run`.

## Installed for this run

- Workbox: `~/.local/opt/strobe-0.19.0/` (17 MB; `npm pack @hona/strobe-linux-x64@0.19.0`, the newest release, the same way as 0.14.0), `~/.local/opt/bun-1.4.4-profile/` (476 MB, `bun-linux-x64-profile.zip` of Bun v1.4.4), `~/.local/share/strobe/` (7.6 MB, the recordings above), and `/tmp/opencode/load-perf/` (scripts and analyses; the database copy is deleted). No `strobe up`, no daemon, no sysctl.
- Mac: `~/.local/opt/strobe-0.19.0/` (darwin-arm64) and `~/.local/share/strobe/` (16 MB, rec_944687 and rec_b94bf2).

# Questions and background questions under load (workbox, 2026-11-11)

The owner saw slowness with questions and background questions open, and questions that did not scroll. The workbox load was 38–42 on 16 vCPUs at the start and 18–40 while measuring.

## What it says

- **The owner's five TUIs could not scroll a long question: they run code from before the fix.** They run `opencode-2.2.5-prime.d22f11a9`, started about 41 hours earlier. That build has none of `ebac2e977f` (scroll a question taller than the form dock), `0e620d7588` (the dock gives way to a docked form) or `7a649c0281` (the crash fix). **measured** with `git merge-base --is-ancestor`. Restarting them on the current build fixes it.
- **On the current build (`cd6d8ecd`), both forms scroll under the workbox's load.** `scenarios/question-scroll.ts` ran on the workbox at load 30–40, for the built-in `question` form and for `/answer`'s form. In both, the wheel moved the form off line 1, PageDown reached line 60 and the options, and ↓ Enter picked "Drop it", which the model then read. **measured** from the frames the scenario saved. `tests/question-scroll.test.ts` still fails on the workbox, and it fails the same way at the base commit. Its expected key line is `↑↓ select  pgdn scroll  enter submit`, but the workbox frame has one more column of left chrome, so the line wraps after `pgdn scroll`. The same test passes on the Mac. `tests/questions.test.ts` fails on the workbox at the base commit too: `cmd/prime` failed to load in that run, and the composer line came out as `┃  typed-after-answer`. Both failures come from the environment, not from scrolling. **measured**
- **The questions themselves cost almost nothing.** These figures come from `scenarios/question-latency.ts` on a scratch service with the owner's TUI plugins, using the fork's `SIGPROF` JS profiles of the scratch TUI. Counts are profile samples, about 1 ms of JS each. **measured**
  - TUI CPU at idle: 0.058 cores with no questions, 0.058 with four background questions and the tray, and 0.061 with `/answer`'s form open (400 tool groups, no subagents). The main thread was 1.2–1.3% busy in all three.
  - Typing in `/answer`'s custom answer cost about 555 JS samples in 10 s outside the test harness. Of those, the form took 1 and the dock took 8, mostly `changedSession` (6) and the 2 s poll.
  - Per key, from the key to the frame that shows it: composer p50 14–20 ms, form arrows 18–26 ms, form typing 10–14 ms. A held key at 30/s settled 6–35 ms after the last key. The harness's own frame captures are about half of the TUI's CPU in these windows, so the absolute figures run high.
- **The slow keys come from the transcript: the root session re-reduced all of its rows on writes that changed nothing it shows.** This is core (fork) code. **measured**
  - With 30 background subagents in the family, composer keys had a p90 of 49–344 ms and a max of 84–1,922 ms. The stalls came as the subagents finished.
  - The profile put `createSessionRows`' `rebuild` (`packages/tui/src/routes/session/rows.ts`) at about 1,000 samples in 10 s. It ran inside the event batch flush and `session.sync`.
  - Counting each trigger over one run (30 subagents, 200 groups) gave 203 full rebuilds: 49 from the revert boundary, 38 from the queued inputs and 116 from the message list. Solid's `on(deps, …)` runs on every run of `deps`, and `deps` ran again on every replacement of the session's info (each refresh of a running session), its pending list or its message list, even when its value was the same.
  - The owner's families have up to 171 sessions and 18,487 messages, and a rebuild walks the whole transcript, so there each extra rebuild costs more. **inferred**

## Fixes

1. **Fork `314c9607bf` (pushed to `prime-look`):** `perf(tui)`. Each rebuild trigger in `rows.ts` is now a memo that notifies only when its value changes: the boundary as a string, and the queued and message triggers as key lists. The guard is `data.test.tsx` "a fresh read of the session that moves no revert boundary, or an answer streaming in, leaves its transcript rows unreduced". It fails on the old code (9 reduces where 4 are expected, and 4 where 3 are expected with only the boundary memo) and passes on the new one.
   - Rebuilds in the same run went from 203 to 49: boundary 49 → 0, queued 38 → 0, messages 116 → 47.
   - During the 200-group first turn alone, rebuilds went from 77 to 6. **measured**
   - Composer keys, A/B on the same scenario (alternating before and after, three runs each, load 24–39):
     - p90: 306, 49, 344 ms before; 146, 126, 126 ms after.
     - max: 909, 84, 848 ms before; 277, 741, 535 ms after.
     - The runs are noisy. The 47 rebuilds left are the subagents' completion messages, each a full re-reduce, and that is where the remaining stalls come from. **measured**, ranges as listed
2. **Dotfiles `235d789c`:** `perf(questions)`. A reading of the open questions that changes nothing no longer sets new state. This covers the dock's 2 s poll (`tui/questions.tsx`) and herdr's reader (`mods/herdr/opencode/asked.ts`). `changedSession` also turns away an event of any other type before the Effect Schema decoder runs, since every event of every session passes through it. The share is small: 6–8 samples in 10 s. **measured**
3. **Dotfiles `12e0643d`:** `scenarios/question-latency.ts`, the scenario behind these numbers.

## Next, by size

- **Make the remaining rebuild incremental.** When the message trigger's only change is a new message at the end, the live handlers have already appended it (`appendMessage`), so the full re-reduce could be skipped. Expected: most of the 47 rebuilds left, and the stalls when many subagents finish together. **inferred**
- **The owner's TUIs at idle are 39–71% timers.** On 2.2.5, 0.08–0.19 cores and a main thread 6–15% busy (rec_a8206d, rec_c2db3a, rec_b75bd0, rec_17d3ba, rec_094c04), with no second at 90% or more. Naming those timers needs a `SIGPROF` profile of an owner TUI, which only the owner may send. The server was at 0.20 cores (rec_03779c). **measured**

## Installed for this run (removed at the end)

- Workbox: strobe 0.19.0 and Bun 1.4.4's profile build, left over from 2026-11-08 and reused; the recordings `rec_a8206d`, `rec_c2db3a`, `rec_b75bd0`, `rec_17d3ba`, `rec_094c04` and `rec_03779c`; and the scratch checkouts in `/tmp/opencode/question-perf/`. All of them were removed after this run. No daemon, no sysctl.

# Opening a large session cold (workbox, 2026-11-11)

The bite-20590 TUI (session `ses_e56b9128cffefdrzi81wdvK7mF`: 5,226 messages, 559 child sessions) showed "Finishing startup…" for 80–90 s at about 105% CPU and 518 MB RSS before the session appeared. Its plugins had finished loading 1.5 s in. The orchestrator measured this at 16:40Z, at load about 30.

## How it was measured

`scripts/perf/startup.ts` starts a server and a TUI from a fork checkout. The TUI runs in a pty of its own and is read through `@xterm/headless`. It reports the ms until the first frame that shows the transcript with no startup loader, and the TUI's CPU seconds and RSS at that point (from `/proc`). With `--prof`, it sends `SIGPROF` to the TUI, which makes the fork write a 10 s JS profile.

All runs used the same setup:
- a copy of the workbox database in `/tmp/opencode/startup-perf/db` (the server writes to its copy, never to the owner's);
- the owner's eleven TUI plugins;
- the owner's `cli.json` settings (theme `prime`, sidebar hidden);
- 160×45 cells, load 23–46 on 16 vCPUs.

From source, the bare TUI takes 6.6–7.4 s and 9–10 CPU s to reach its home frame, in every run. That boot includes transpiling, which an installed build does not do (**inferred**), so the useful figure is the time after that.

One scratch-only workaround: `solid-js` was linked into the scratch dotfiles' `node_modules`. Without it, `cmd/prime`, `cmd/herdr` and `cmd/skills` fail to load from source with "Cannot find package 'solid-js'". This is the same failure behind the `tests/questions.test.ts` result above.

## What it says

- **Each of the 559 children's permission and form syncs re-ran every reader of the whole family.** This is core code. **measured**
  - On opening, the session route syncs the pending permissions and forms of every descendant (`routes/session/index.tsx`, `descendantSessionIDs`): 1,118 requests.
  - Each answer, even an empty one, wrote a new key into `store.session.permission` or `store.session.form`.
  - Each write re-ran the readers that walk every member of the family: the session tabs' `status` with `family()`, `program-status`'s report, and the tab rail.
  - That makes the cost about 1,118 × 559 store reads. In the base profile (3–13 s), 9,181 samples: `session-tabs.tsx:138` held 5,713 of them inclusive, the two syncs 4,025 and 3,940, and `program-status.ts:32` 2,972. By own time, it was Solid's `readSignal` (21%), store `get` (19%) and `cleanNode` (11%).
- **The cache plugin's sidebar line loads every descendant's transcript.** When the sidebar is shown, `mods/cache/tui/ledger.tsx` `sidebar()` syncs the messages of all 559 children, judges each one, and runs again as each one arrives. **measured** in a run with the sidebar shown (no config, three plugins not loaded): the transcript appeared at 18.8 s and RSS reached 1.4 GB. The profile showed `message.sync` at 4,093 samples and `sidebar` at 2,676. The owner hides the sidebar, so this cost does not reach the owner today.

## Fixes

1. **Fork `a401573897` (pushed to `prime-look`):** `perf(client)`. A permission or form sync that finds nothing pending, where nothing was pending before, writes nothing. Every reader already reads a missing list as empty. A list that becomes empty is still written, so a cleared request still reaches its readers.
   - The guard is `data.test.tsx`, "syncing a family whose members have nothing pending leaves the readers of the family unrun". On the old code a family reader runs 41 times where 1 is expected. On the new code it passes.
   - Time from launch to the transcript, same fixture, owner's plugins and settings: **measured**

     | | Transcript shown | TUI CPU by then |
     | --- | --- | --- |
     | Before, 2 runs | 31.7 s, 35.8 s | 36.5 s, 40.9 s |
     | After, 5 runs | 9.7 s, 11.1 s, 10.4 s, 9.8 s, 10.0 s | 12.0 s, 14.6 s, 13.7 s, 11.8 s, 12.2 s |
     | No plugins, before | 19.3 s | 22.0 s |
     | No plugins, after | 7.6 s, 7.6 s | 10.0 s, 10.2 s |

   - Peak RSS stayed in the 430–590 MB range.
   - After the fix, the transcript shows 2.6–3.7 s after the home frame. The profile of that window has 1,288 samples spread across mounting the transcript and the plugins' slots, with no single hot spot.
2. **Fork `abe903b282` (pushed):** `perf(tui)`. A transcript rebuild whose rows only grew at the end, or did not change, now appends the new rows (or does nothing). Before, it re-keyed and reconciled every row. This was the r1 follow-up: a finished subagent's report, or an idle marker, still goes through a reduce, but no longer through the keyed reconcile.
   - The guard is `data.test.tsx`, "a message that only adds rows at the end appends them and leaves the transcript's rows as they were". It fails on the old code, because the old code re-keys the live row.
   - Cost per rebuild on the Mac (bench of `reduceSessionRows` plus the store pass; reconcile and compare times are 2-run means): **measured**

     | Transcript | Before | After |
     | --- | --- | --- |
     | 800 messages, 2,000 rows | 6.7–7.4 ms | 2.8–3.3 ms |
     | 200 messages, 500 rows | 1.9 ms | 0.8–0.9 ms |

   - This was not re-measured with the r1 subagent scenario on the workbox.
3. **Dotfiles:** `scripts/perf/startup.ts`, the harness behind these numbers.

## Next, by size

- **One request for the family's pending requests instead of 1,118.** The server's `permission.request.list` and `form.list` are per location. A family-wide list, or a pending flag on each session's info, would let the route sync only the members that have something pending. **inferred**
- **The cache sidebar line should not load 559 transcripts.** Possible approaches: judge only the live and recent children, or have the server's `CACHE_LEDGER` answer for a whole family. This matters only when the sidebar is shown. **measured** above.
- **The owner's 80–90 s vs. 32–36 s here.** That TUI runs the installed 2.2.x build in a herdr pane next to four others, at a similar load. The gap is not explained. The fix removes the quadratic either way. **guess**

## Installed for this run (removed at the end)

- Workbox: `/tmp/opencode/startup-perf/` (fork and dotfiles clones, the database copy, the runs and their profiles) and `/tmp/opencode/sp-setup.sh`. Both were removed after this run. Strobe was not needed: the fork's `SIGPROF` profiles named the code.

# Opening it on a compiled build (workbox, 2026-11-11, later)

The same session, now on compiled builds (`bun run script/build.ts --single`), so the boot is the installed one. `scripts/perf/startup.ts --bin` reports, in ms from the TUI's spawn:
- `first`: the first frame of any kind, which ends the TUI's own boot;
- `transcript`: the first frame past the loader that shows the transcript;
- `ready`: the frame with the `--ready` text, here the questions plugin's "Nothing is waiting for your answer now.";
- `open` = ready − first;
- `interactive`: when keys typed at `ready` echo in the composer.

The setup was the same as above (the database copy, the owner's eleven plugins and `cli.json`, 160×45), at load 37–49. Each build ran 3 times in alternation; the first run of each started with an empty cache.

| Build | first | transcript | ready | open | interactive |
| --- | --- | --- | --- | --- | --- |
| Before (`abe903b282`) | 3.9, 2.5, 2.8 s | 6.6, 5.5, 5.5 s | 6.6, 5.5, 5.5 s | 2.7, 3.0, 2.8 s | 6.8, 5.6, 5.6 s |
| After (the three commits below) | 3.4, 2.7, 2.8 s | 4.7, 3.9, 3.7 s | 4.9, 4.2, 4.0 s | 1.5, 1.5, 1.2 s | 5.0, 4.3, 4.1 s |

**measured**. Under 1 s for the open is not reached. What remains, from the TUI log at debug level: **measured**
- About 0.8 s passes from process start to "cli starting". Another 1.2–1.6 s passes before "event stream connecting". The first frame (the plugin loader) lands about there. This is the boot, and it is half of the time.
- Plugin reconciliation took 1.4–1.8 s before; the owner waits for the plugins before the session draws (owner's ruling, 2026-11-11). On a warm cache it takes about 0.7 s. The per-plugin read stage was led by prime at 842 ms before.
- The transcript draws 0.1–0.3 s after the plugins are ready.

## Fixes

1. **Fork `cc890ed507`:** `perf(session)`. Opening a session made 1,118 requests (one permission sync and one form sync per member). It now makes one: `GET /api/session/:sessionID/family/request` returns the family's member ids, pending permissions and forms. Members whose instance is not live are skipped. The client writes the lists and marks each covered member's syncs as done, so only a member the read did not cover (a newer child, or an older server) is synced on its own. The guards are `data.test.tsx` "one family read fills every member's pending requests, and a member it covered is not read again" and `packages/server/test/session-family-request.test.ts`.
2. **Fork `078cd8dec6`:** `perf(tui)`. OpenTUI runs every plugin `.ts`/`.tsx` through Babel on each start: 456 files in about 0.9 s on the Mac (**measured**, bench). A release build now keeps each compile on disk under `<cache>/solid-transform/<version>/`, keyed by the sha256 of the path and the source. A changed source compiles again. Guard: `test/plugin/solid-transform-cache.test.ts`.
3. **Fork `9c2035d3f8`:** `fix(tui)`. The loader appeared after 0.5 s and then held "Finishing startup…" over a session that was already drawn until 3 s after it appeared. It now leaves when the plugins are loaded. This is most of the drop in `ready`. Guard: `test/component/startup-loading.test.tsx` (red on the old code).
4. **Dotfiles:** the cache sidebar line (`mods/cache/tui/ledger.tsx`) reads the share from each session's token totals and judges only the transcripts the TUI already holds. It no longer fetches a transcript. With the sidebar shown (`"sidebar":"auto"`), the after build, the owner's plugins, and `--hold 40000`: **measured**

   | | ready | TUI CPU by then | peak RSS | sidebar line |
   | --- | --- | --- | --- | --- |
   | Before | 101.2 s | 101.4 s | 1,468 MB | Cache 95% |
   | After | 4.3 s | 5.1 s (6.1 s at 44 s) | 438 MB | Cache 95% |

   Guard: `ledger.test.ts` "the sidebar line of a family of hundreds reads token totals, and fetches no subagent's transcript" (on the old code it syncs 302 transcripts).
5. **Dotfiles:** `scripts/link-fork.ts` linked each package to the fork with absolute links. Syncthing carried the Mac's links to the workbox, where they point nowhere: on 2026-11-11 the workbox's `mods/*/node_modules/solid-js` pointed at `/Users/cvr/...`. A TUI started there then fails to load prime, herdr and skills ("Cannot find package 'solid-js'"). The links now go through a per-machine anchor, `~/.local/state/opencode-fork/<checkout path under home>/modules`, and are relative to it. Every machine writes the same link text, and pointing a checkout at another fork rewrites only its anchor. The workbox needs one `link-fork` run (the daily build does it) to create its anchor. Until then, the synced links point nowhere there, as they do today.

## Next, by size

- **Boot, 2–2.5 s of the ~4 s:** process start to "cli starting" (0.8 s), then to the event stream (1.2–1.6 s). Nothing is logged in between; profile the compiled boot. **measured** (log)
- **Plugin load, 0.7–1.8 s:** prime's read stage is the largest. Reconciliation resolves plugins one at a time (`plugin/context.tsx`). **measured** (log), **inferred** (sequential)

## Installed for this run (removed at the end)

- Workbox: `/tmp/opencode/family-batch/` (the fork and dotfiles clones, the database copy, the compiled builds and the runs) and `/tmp/opencode/fb-setup.sh`. Both were removed after this run.

# The boot before the session (workbox, 2026-11-11, round 4)

The goal was the same: a usable session in under 1 s on the compiled build. This round adds a boot trace to the fork. Run with `OPENCODE_BOOT_TRACE=<dir>`, the TUI writes `boot-<pid>.json` after `OPENCODE_BOOT_TRACE_MS` (15 s by default). That file holds a `performance.now()` mark for each step, from the binary's first import to the session's messages. `OPENCODE_BOOT_TRACE_PROFILE=1` also writes a CPU profile that starts at the first import. Without the variable, the trace does nothing. `scripts/perf/startup.ts --trace` collects it, and `--trace-profile` adds the profile.

## Harness artifacts, ruled out first

Each of these cost time in the harness only. The owner does not pay them. **measured** (trace and profile)
- **Terminal queries:** the TUI waits up to 1 s (`renderer.waitForThemeMode(1000)`) for the terminal to answer OSC 10/11. `@xterm/headless` never answers, and herdr's binary contains the reply format. `--replies` answers as a desktop terminal does. Without it, both builds lose about 1 s: 2.6 s (before) and 2.0 s (after) to ready.
- **A fresh server:** the harness starts its own server. Its first `server.info` took 350–460 ms, and the location's first read through `fs.list` took 200–1,350 ms. The owner's long-running service has both warm. `--warm` loads the location on the server first, and `--settle 5000` lets the server settle.
- **The Solid transform cache:** each run name keeps its own cache, so the first run of a name compiles every plugin through Babel. That alone took 700 ms of the main thread in one profile. `cmp.sh` runs each build once before it records anything.
- **Tabs:** the harness runs with tabs on. The owner runs in herdr (`HERDR_ENV=1`), where `"auto"` turns them off.

The 0.8 s from process start to "cli starting" in the last section is not there on a settled box. The binary's first import comes 80–145 ms after spawn, and "cli starting" follows 1–20 ms later. **measured**

## Where the time went (before)

The profile showed the JS thread fully busy from the first frame until ready. **measured** (profile, 3cd1e36717)
1. **The session's reads waited for the plugins.** `session.sync`, `message.sync` and `pending.sync` started at the route's mount, which happens after `plugins.ready()`. The session's info was written only after every page of its children: 572 children, 3 pages of 200.
2. **Hundreds of children on the transcript's first draw.** Once the family was in the store, the subagent views worked through all 572 children: `subagents/opencode/view.ts` `read`/`sessionOf`, `subagent-row.ts` `order`/`rowsOf`, `works.ts` `worksOf`, `prime/subagent.ts` `subagentOrder` and `questions/tray.ts` `under`. Each family walk grouped children by copying the parent's list for each child, which is quadratic. `under` also checked membership with `Array.includes`. In the client, `registerSession` checked each family member through the store's proxy: 82 ms of `includes` self time.
3. **Plugin read and evaluation, 574 ms**, after the renderer was up. It started only when the plugin provider mounted.

## Fixes

Fork, on `1e840dd4b8`:
- `3cd1e36717` `perf(cli)`: the boot trace.
- `160cf043d8` `perf(client)`: a family read writes the session's own info as soon as `session.get` returns. Guard: `data.test.tsx` "a family read shows the session's own info before its children's pages arrive" (red on the old code).
- `7c9ac11ba3` `perf(tui)`: the session's reads start when the event stream connects, while the plugins load.
- `0552528337` `perf(tui)`: `plugin/prewarm.ts` starts importing the configured local plugins as soon as the config is read. Imports are kept per entrypoint for the whole process, so the provider's first reconciliation finds each graph already evaluated. Guard: `test/plugin/prewarm.test.ts`.
- `e2c00fcdc9` `perf(client)`: a family read writes its children one page at a time, after the session's own info.
- `36dc222658` `perf(tui)`: the shown session's children are read 750 ms after the first frame past its synced transcript. A background tab still reads its own family.
- `7e96275974` `perf(client)`: the family index checks membership on the raw arrays.
- `b96b5e07e4` `perf(tui)`: trace marks for the family's size and for when the children are read.
- `2f97d666b6` `perf(tui)`: `-s` starts on its session's route. Before, the route was home until the app mounted, so the tabs' read at connect took the shown session for a background tab and read its whole family. Guard: `app-lifecycle.test.tsx` "a session opened with -s reads its children well after its messages" (red at `3cd1e36717` and `7c9ac11ba3`). In the same file, the fake server in "session title generated while an untitled session is loading remains visible" now returns the new title for a read it starts after the rename, as the real server does. The deferred children read is such a read. The stale read that started before the rename is still the one the test guards.

Dotfiles: the family walks (`questions/tray.ts`, `subagents/works.ts`, `subagents/subagent-row.ts`, `prime/subagent.ts`) now group children in linear time.

## Before and after

Setup: the workbox, the database copy, the owner's eleven plugins, 160×45, load 19–24, with `--trace --replies --warm --settle 5000`. Five runs of each build alternated, after one unrecorded run of each. Before is `3cd1e36717` (the trace only) with the mods at `b3a401c7`. After is the fork head with the mods at this branch. Medians in ms from spawn: **measured**

| Phase | Before | After |
| --- | --- | --- |
| cli starting | 105 | 131 |
| CLI default handler | 181 | 231 |
| TUI location read | 203 | 394 |
| first frame (loader) | 372 | 539 |
| plugins: reconcile start | 265 | 531 |
| plugins: first reconcile done | 665 | 724 |
| plugins ready | 910 | 806 |
| session info | 488 | 613 |
| session messages | 1,108 | 904 |
| **ready** (transcript with the composer's model) | **1,697** (1,479–2,150) | **1,180** (1,031–1,768) |
| **key echo** | **1,804** (1,582–2,336) | **1,282** (1,134–1,975) |

The steps before the plugins come later now: the plugins' imports run on the same thread while the location loads. They finish sooner, and the session's reads overlap them. In the three runs right after the `-s` route fix, ready was 1,640, 957 and 875 ms and key echo was 1,691, 1,114 and 927 ms (the first of the three ran with a cold cache). **measured**

Under 1 s is reached on some warm runs and not on the median. What remains: **measured** (profile)
- **About 250–350 ms from the session's messages to ready.** This is the transcript's first draw (styles, rows) together with the plugins' second reconciliation, which runs when the server's TUI plugin list arrives. Its watch stage took about 0.5 s in a debug log.
- **About 150 ms of plugin evaluation on the main thread** before the location read returns.

The family cost in the session's header now climbs as the children's pages arrive, about 1 s after the transcript shows.

## Installed for this run (removed at the end)

- Workbox: `/tmp/opencode/tui-boot/` (the fork and dotfiles clones, the database copy, the compiled builds and the runs) and `/tmp/opencode/tb-setup.sh`. Both were removed after this run.
||||||| b3a401c7

# From an answer's submit key to its effect (2026-11-11)

The target: the form closes on the next frame, the answer shows in the transcript within 100 ms, and the model request starts within 300 ms, whatever the transcript's size. `scenarios/answer-latency.ts` times both paths from the return key that submits: `async` (a background question answered through /answer's form) and `builtin` (the built-in `question` tool). It reports three times: `closed` (first frame without the form), `shown` (first frame with the answer in the transcript) and `request` (the simulated model receives the request that carries the answer). Sizes: a fixture of 20 tool groups (small), 1,500 groups (Mac large), and on the workbox a read-only copy of the owner's session `ses_e56b9128…` (5,286 messages, 559 children, 19 MB) opened with `LAT_SESSION`. The figures are medians in ms, written closed / shown / request. **measured**

| Where | Before, async | Before, builtin | After, async | After, builtin |
| --- | --- | --- | --- | --- |
| Mac, small | 35 / 64 / 25 | 46 / 46 / 36 | 15 / 35 / 20 | 23 / 41 / 15 |
| Mac, 1,500 groups | 24 / 96 / 90 | 18 / 56 / 83 | 13 / 61 / 80 | 10 / 56 / 70 |
| Workbox, small | 94 / 175 / 47 | 152 / 152 / 61 | 38 / 90 / 41 | 34 / 34 / 36 |
| Workbox, owner session copy | 123 / 243 / 164 | 141 / 141 / 119 | 45 / 74 / 130 | 31 / 31 / 97 |

The workbox ran at a load of 35–52 on 16 vCPUs throughout, so a single round can still be slow: in the 5-round after-run on the owner session copy, async rounds ranged 32–131 / 67–158 / 95–234.

## What it was

- **The server was not the cause.** It finished a reply in about 15 ms, and nothing in the path debounced or polled. A 1 ms timer probe on the workbox showed a p99 lateness of 6 ms, so the delay was CPU work, not scheduling. **measured** with trace lines in a scratch copy
- **The TUI's event loop stayed busy for 80–150 ms after the key.** **measured** with the fork's `SIGPROF` profiles
  - The form waited for the server's `form.replied` event before it closed.
  - Closing the form remounted the composer (about 30 ms of CPU).
  - Every flip of a keymap layer's or command's `enabled` (run status, typed text, the stash) registered the whole layer again: 31 session commands, 63 app commands. Each registration recomputed every view of the keymap.
  - `useShortcuts` built one keymap selector per caller, which is one per assistant footer in the transcript. Every keymap change formatted every command's bindings once per footer.
  - Each `session.sync` on a run start and end replaced the session's info, and that woke every reader of every field of the session (subagent rows, tabs, status).
- **On the server, the drain's prompt preparation ran inside the wake.** On a large session, that held the answer's own events and the HTTP reply back by 50–80 ms. **measured**
- **The questions tray read a sheet for every session in the family.** That is hundreds of subagents, every 2 s and on every change. **measured** in the profile as `mods/questions` frames

## Fixes

- Fork (pushed to `prime-look`):
  - `perf(client)`: a form closes as its reply is sent. On a refusal other than not-found or already-settled, it comes back where it was. A session refresh reconciles the info instead of replacing it.
  - `perf(tui)`: an `enabled` accessor becomes a reactive matcher, so a flip no longer registers its layer again. Shortcuts, commands, and pending and active keys are each one memo per keymap provider.
  - `perf(tui)`: the composer stays mounted, hidden and disabled, under forms, permissions and pickers.
  - `perf(core)`: a drain starts on the next turn of the event loop, after the writes of what woke it.
- Dotfiles: `perf(questions)`: reading the open questions of a family reads only the sessions that have a sheet.

## Left

- ~~The answer's typed text is lost on a refusal.~~ Fixed in round 2 (fork `8ab6661adf`). A refused reply or cancel, such as a 500 or a connection dropped by a service restart, now brings the form back with what was typed and the error. A read of the forms already in flight when the reply goes out no longer lists the sent form again. The guards are `form.test.tsx` "a refused reply brings the form back with the typed answer and its error" and `data.test.tsx` "a read of the forms in flight when a form's reply goes out does not bring the form back". Both fail at `40879daaa7`. The latency held on the Mac (medians, closed / shown / request): small async 16/29/16 and builtin 9/25/10; 1,500 groups async 16/61/84 and builtin 11/75/98. **measured**
- The async `shown` time still trails `closed` by 30–60 ms on the workbox: the notice row waits for `session.inbox.enqueued` to arrive and for the next frame. **inferred** from traces
||||||| 7d3553b8

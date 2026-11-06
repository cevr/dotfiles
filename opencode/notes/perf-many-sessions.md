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

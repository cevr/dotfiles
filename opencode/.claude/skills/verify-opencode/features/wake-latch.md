# Wake latch

A subagent start that orchestrate's pace or the Sabbath holds is not refused and not lost: it becomes a latch, a wake entry under the parent. The call answers at once that it latched; the child session exists, marked latched, with no prompt yet; `wake_list` lists the latch with what holds it and when it opens; at its recheck orchestrate decides it again, and once admitted the subagent starts in the background on that same child and its result wakes the parent as any background subagent's does. `wake_cancel` drops it. A latch survives a reload and downtime as an alarm does.

## Sub-features

- `latch-hold`: a held start answers latched, with the hold and when it opens.
- `latch-list`: `wake_list` shows `latch · the worker subagent "<description>" (sessionID: <child>) · held by the pace: <reason> · opens <time>`.
- `latch-recheck`: decided again while still held, it latches again with the new times.
- `latch-open`: once admitted, it starts in the background on its child; the result wakes the parent.
- `latch-cancel`: `wake_cancel` drops it; the child's mark reads cancelled.
- `latch-keep`: a reload or downtime keeps it, firing at once when overdue.
- `wake-alarm`: the plain alarm and monitor the same plugin keeps (`wake`, `monitor`, `wake_list`, `wake_cancel`, `job`).

## How to get to it (user POV)

- The agent's `subagent` call while the pace holds new agents, or on the Sabbath.
- `wake_list` and `wake_cancel`, direct (a root session's; a subagent is refused the wake tools).
- Prime's rows: the latched subagent's row reads `Latched` with its hold and when it opens.

## Driving it with the world

- **Preconditions:** orchestrate and wake loaded for one location, and a pace that holds: the suite's stand-in pool plugin holds every new agent for the first twelve seconds, then admits.
- **States:** held (latched), open, cancelled, a reload. Error is `cmd/wake/wake-faults.sim.test.ts` (failed writes, downtime). Loading is `n/a`.
- **World suites:** `cmd/orchestrate/orchestrate-latch.sim.test.ts`, `cmd/wake/wake.sim.test.ts`, `cmd/wake/wake-faults.sim.test.ts`
- **Code:** `mods/wake/`, `cmd/wake/`, `mods/orchestrate/`, `cmd/orchestrate/`, `sim/`
- **Regression:** `mods/wake/*.test.ts`.

1. **Hold.** The parent's model calls `subagent` with `{ "agent": "worker", "description": "Check the export", … }` while the pace holds. The answer says it latched; the child exists with its `latch` mark.
2. **List.** The parent calls `wake_list`. The answer names the latch, the subagent, its child, the hold and when it opens.
3. **Open.** Time moves past the hold (`world.until`); the latch is decided again, admitted, and the worker runs on the same child, its report waking the parent.

## Driving it with real OpenCode

- **Real:** `tests/prime-latch.test.ts`, `tests/wake.test.ts`

A scratch server has no pool, so nothing holds a start: a latch is unreachable there by a user path (report it so). Its drawn row is proved by `tests/prime-latch.test.ts` (`scenarios/prime-latch.ts`). The plain alarm is reachable:

1. **Alarm.** Type `verify: call wake {"afterSeconds":600,"note":"verify wake"}`, Enter. Wait for `set: it wakes this session`.
2. **List.** Type `verify: call wake_list {}`, Enter. The answer lists the alarm and its note.
3. **Cancel.** Type `verify: call wake_cancel {"id":"<the id from step 1>"}`, Enter; `wake_list` again answers no pending entry.
4. **Proof.** Snapshot after each step into `$EVIDENCE/wake-latch/`.

## Gotchas

- `verify:seed` loads wake with `backstop: "off"`: its OS jobs stay in memory, so nothing outlives the scratch server. Never seed wake with the cron backstop.
- On the Sabbath (Friday sunset to Saturday sunset at the host) orchestrate latches every role start; a real run then latches with no pool at all.
- A subagent calling `wake` is refused: drive the wake tools from a root session.

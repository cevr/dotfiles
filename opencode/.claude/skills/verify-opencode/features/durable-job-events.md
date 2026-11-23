# Durable job events

A job a session starts (`job({ command, note })`) runs outside the server, and its end reaches the session once without anyone polling it. The run's receipt ends the worker's turn; while the job runs no model request, no `check` and no per-job timer looks at it. The job's runner writes the exit (with its kind: succeeded, failed, spawn-failed, signalled, timed out, cancelled) before it calls the service, and that call steers the end letter into the session at once, with the exit, the log's tail, the note and a typed end (`End: failed (generation 1); log job-log:<id>/1.`). With no runner's call (the backstop off), the service's one watch on the job's own directory, opened when the job is admitted (or at start for a job already kept) and closed once its end is delivered, announces the exit file the moment it is written, and the same exactly-once path delivers it; a watch only announces, the end is read from the files. A call lost to a reload or an outage is made up by the next start; one lost while the server ran, an exit event the watch missed, a host out of watches (the job falls back to the sweep, logged), a runner gone without an exit (`lost`) and a launch nobody claimed (`never-started`) are found by the wakes' one recovery sweep within a minute. The owner's own `park`, `wait` or `kill` that returns the end is its delivery, and then no letter follows; a `check`, the TUI's stop or an ancestor's kill takes nothing. A busy owner, a failed write, a lost acknowledgement or two locations never make a second letter or a second turn.

## Sub-features

- `job-event-receipt`: `job` run answers with the id and log, and says the end comes once and not to poll; the turn ends there.
- `job-event-doorbell`: the runner's call after its exit is written steers one letter at once, with `End: <kind> (generation 1); log job-log:<id>/1.` and the letter's `event` metadata.
- `job-event-watch`: with the backstop off, the job's watch announces its exit and one letter goes at once; watches number the live jobs and none is left once every end is delivered.
- `job-event-recovery`: an end whose call was lost (reload, outage, two locations) or that no call announces (a runner gone, a launch never claimed) is delivered once, by the start or within a minute by the sweep.
- `job-event-owner`: `job({ action: "park" })` answers at once (the end, then no letter; or that it runs); `wait` blocks until the end without polling; the owner's `kill` that sees the end delivers it.
- `job-event-not-stolen`: `check`, the TUI's stop and an ancestor's kill leave the letter owed.
- `job-event-exactly-once`: failed writes, a lost acknowledgement, a busy owner at boot and deletion never make two letters or two turns for one end.
- `job-event-claim`: the runner claims the job before it runs anything; a second runner runs nothing, and a reused pid never reads as the runner.

## How to get to it (user POV)

- The agent's `job` tool: `run`, `check`, `park`, `wait`, `kill`, `list`.
- Prime's Jobs tab and dock: the owner's stop (the wakes' `kill` RPC).
- The runner's own call when a job ends (`cmd/wake/job.ts` through the OS backstop's script), and the service's start.

## Driving it with the world

- **Preconditions:** the wakes plugin loaded with `backstop: "off"`; the test drives the job's runner through the memory runner (`MemoryRunner.running`, `ended`, `lost`, `spawnFailed`) and rings `due` as the runner does.
- **States:** default (a job runs, ends, wakes), refused (a write that dies, a call that finds no server), error (a runner gone, a command that never started), empty (`park` on a running job). Loading is `n/a`.
- **World suites:** `cmd/wake/job-events.sim.test.ts`, `cmd/wake/job.sim.test.ts`
- **Code:** `mods/wake/job-event.ts`, `mods/wake/job.ts`, `mods/wake/model.ts`, `mods/wake/service.ts`, `mods/wake/process/runner.ts`, `mods/wake/process/supervise.ts`, `mods/wake/memory/runner.ts`, `cmd/wake/job.ts`, `cmd/wake/server.ts`
- **Regression:** `mods/wake/job-event.test.ts`, `mods/wake/process/runner.test.ts`, `mods/wake/memory/model.test.ts`, `cmd/wake/server.test.ts`.

1. **Receipt.** A root session's model calls `job` with `{ "command": "make check", "note": "ALPHA: read the result" }`. The answer reads `Job j…… started. Log: …` and `When it ends, a letter … starts a turn here, once.`; the model ends its turn.
2. **Quiet.** Five minutes pass with the job running: no model request, no `job` call.
3. **Doorbell.** The runner records exit 3 and rings `due`: the letter `⏰ Job j…… exited 3 …` with `End: failed (generation 1); log job-log:j……/1.` is in the session at that instant, and one turn reads it.
4. **Watch.** With no call rung, `MemoryRunner.announce` stands for the exit file's event: the letter is there at once; `runner.watched` holds one entry per live job and is empty at the end.
5. **Recovery.** A reload or an outage while the job ends, or a call never made: the start, or the sweep within a minute, steers the letter once.
6. **Owner.** `park` on an ended job answers `This answer is its end: no letter follows.`; on a running one, `It runs: end your turn; its end letter comes once.`

`bun run verify:drive --feature durable-job-events` runs those suites.

## Driving it with real OpenCode

- **Real:** `tests/job-events.test.ts`

The real leg runs the process runner itself (no OpenCode server, no cron job, no model): a scratch directory, a harmless command that writes a marker and exits 3, and a scratch HTTP server standing in for the service's `due`.

1. **Run it.** `bun test tests/job-events.test.ts` from `opencode/`. It launches the job through `mods/wake/process/runner.ts`, reads the exit the runner wrote (kind `failed`, generation 1, its sequence) and the marker, and sees the runner's call reach the scratch server only after the exit was on disk.
2. **Late call.** The scratch server answers the call late; the exit was already readable, so a reader that came first got the end.
3. **Backstop off.** The wakes' model over the process runner, no call configured: the job's own `fs.watch` announces its exit and one letter reaches the session; the runner's call coming late adds nothing; the watch closes; a runner made out of watches still runs the job and its call delivers it. The test logs `exit written to the letter seen` (measured 5–64 ms on the Mac); with the backstop on it logs `exit written to the runner's call arriving` (4–7 ms).
4. **Out of watches.** The watch's open refused with ENOSPC and with EMFILE at the runner's `watch` seam, the sweep's period short (`recoverMs`): each job runs and ends, the sweep alone delivers each end once, and the warning `wake: a job is not watched; the sweep finds its end` names the job and the code. `mods/wake/process/runner.test.ts` makes a real EMFILE by holding every descriptor while `fs.watch` opens. A real ENOSPC needs Linux's inotify limit: the unit's workbox probe lowers it in a user namespace of its own.
5. **Claim.** A second runner on the same job's directory runs nothing; a claim naming a live pid with another start time reads lost, and a kill does not signal that pid.

## Gotchas

- Never seed the wakes with the cron backstop in a check: its runner's call would start a real service. The real leg points the runner's call at its own scratch server.
- The memory runner rings nothing itself: a world test rings `due` where the runner would, or leaves it unrung to prove the recovery.
- The old per-job poll is gone: a test that waited for "the poll" to find an end now rings `due`, or waits up to the sweep's minute.

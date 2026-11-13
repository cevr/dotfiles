# sim-tui

The fork's real TUI, in the test's own process, with our TUI plugins loaded by
the host's own plugin loader, on held time, in front of a scripted server
double. No OpenCode process, no pty. A simulated TUI test is a
`*.sim.test.tsx` beside its composition root (`cmd/<mod>/`), run by the seed
runner (`sim/seed.ts`) unchanged.

## Files

- `app.ts`: the harness. `boot` starts one app per test file through the
  fork's `createAppFixture` (from `OPENCODE_DEV`), with the file's plugins by
  path and the route plugin (`route/`) that lends the harness the router.
  `seed` runs one seed on a fresh double and a fresh session in that app; the
  `Tui` it hands the body has `type`, `press`, `resize`, `advance`, `until`,
  `settle`, `text`, `frame` and `trace`. `runner(file, count)` is the seed
  runner on the file's first `count` seeds. `BOOT_TEST` and `CLOSE_TEST` open
  and close a file (first and last test), so no lifecycle hook is needed.
- `server.ts`: the double. Sessions, messages, parts, the inbox, shells and a
  scripted model (`Model`: the steps a prompt plays: `Text`, `Reasoning`,
  `Stall`, `Shell`, `Subagent`). Every answer and event goes through the
  fork's own schemas (decoded, then encoded): a shape the real server would
  not send fails. `SERVED` lists the routes it answers; a route outside it
  and outside the fixture's defaults (`FIXTURE_ROUTES`) fails the settle
  naming it.
- `golden.ts`, `golden/`: each converted frame's text from one real run of
  its scenario at the base, and the masks (a wall-time duration, a drawn id,
  the working directory, a glyph animated in wall time).
- `app.test.tsx`: determinism (20 generated sequences, each run twice).
- `isolation.test.ts`: a seed alone gives the trace it gives in the full run.
- `static.test.ts`: no wall time in a `*.sim.test.tsx` or in `sim-tui/` but
  `app.ts`.

## What holds time

- Bun's fake timers hold the host's and our plugins' timers, `Date.now` and
  `performance.now`. Our plugins read time through `decider/tui-clock.ts`
  (lint rule `dotfiles/tui-clock-only`), which the harness fills.
- Bun runs a zero-delay timer 1 ms on and its `advanceTimersByTime(0)` moves
  both clocks 1 ms: a settle runs the due timers on its first pass only and
  puts the wall reading back, so no clock depends on how many passes a settle
  took.
- A timer of 60 s or more is never set (the client store's backstop recheck):
  its phase would carry from seed to seed. A seed past 60 s of virtual time
  fails.
- The client's fetch to a loopback host goes straight to the fixture's routes
  in this process; every answer is read whole, so a settle waits on it to the
  last byte.
- `crypto.getRandomValues` draws from the seed (ids are the fork's
  `Identifier`).
- OpenTUI's tree-sitter client, which answers from a worker thread in wall
  time, is replaced by OpenTUI's `MockTreeSitterClient` (no syntax colours);
  `node:perf_hooks`' `monitorEventLoopDelay` reads no delay (the DevTools
  bar's dot).

## Between seeds

A seed ends with every parked request answered and every running session
ended (the client store would read a running one again later). The next seed
goes back to the boot's lobby session on the file's terminal size and spends
6 s of virtual time there (a 5 s toast, a refetch, a retry all fire), then
starts its clock at the epoch. Tool call ids are made per message, since the
TUI keeps state by call id.

## Budget

`sim/seed.ts` gives a file 5 s of wall time for all its seeds. The first boot
of a file is reported on its own line (`sim-tui boot <file>: N ms`) and fails
past 4 s on a quiet host (load under 12). A file whose 20 seeds do not fit
takes the largest count that does (`escape-states`: 4).

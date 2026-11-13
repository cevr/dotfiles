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
  runner on the file's first `count` seeds. `bootTest` and `closeTest` open
  and close a file (first and last test), so no lifecycle hook is needed.
- `server.ts`: the double. Sessions, messages, parts, the inbox, shells and a
  scripted model (`Model`: the steps a prompt plays, made by `text`, `reasoning`,
  `stall`, `shell` and `subagent`; none ends the run). Every answer and event goes through the
  fork's own schemas (decoded, then encoded): a shape the real server would
  not send fails. `SERVED` lists the routes it answers; a route outside it
  and outside the fixture's defaults (`FIXTURE_ROUTES`) fails the settle
  naming it.
- `client-laws.ts`: what the double does, as laws a server keeps; run on the
  double (`client-laws.test.ts`) and on real OpenCode
  (`tests/client-laws.test.ts`, over `law-server.ts`). Every served route and
  event kind is named by a law.
- `effect-test.ts`: a test whose body is an Effect. sim-tui resolves the
  fork's Effect, whose types are not effect-bun-test's.
- `golden.ts`, `golden/`: each converted frame's text from one real run of
  its scenario at the base, and the masks (a wall-time duration, a drawn id,
  the working directory, a glyph animated in wall time).
- `app.test.tsx`: determinism (20 generated sequences, each run twice).
- `isolation.test.ts`: a seed alone gives the trace it gives in the full run.
- `static.test.ts`: no wall time in a `*.sim.test.tsx` or in `sim-tui/` but
  `app.ts`.

## What holds the host's dirs

- Our plugins read HOME and the XDG base dirs through `decider/tui-dirs.ts`
  (Effect Config from a process-wide source, the env by default). The harness
  installs a source with every dir under the file's own scratch before the app
  boots, so no frame shows this machine's files, such as daily's
  `upstream.json` (`host.test.ts` plants one on a fake host and looks).
  A plugin that reads a host file takes its dir from there.

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
  time, is replaced by OpenTUI's `MockTreeSitterClient` (no syntax colours).
- The DevTools bar's UI dot reads the host's real event-loop delay: a frame
  carries it as `○`, in no colour of its own.

## Between seeds

A seed ends with every parked request answered and every running session
ended (the client store would read a running one again later). The next seed
goes back to the boot's lobby session on the file's terminal size and spends
6 s of virtual time there (a 5 s toast, a refetch, a retry all fire), then
starts its clock at the epoch. Tool call ids are made per message, since the
TUI keeps state by call id.

Between files, the app shuts down (renderer, client, event stream, the
fixture's server) on the fake clock before the holds go back; a TUI left
running kept its client in the process and broke the next app's event
stream. The first boot loads the root's Effect (through effect-bun-test)
before the TUI's plugin runtime refuses every Effect but the host's for the
rest of the process.

## Budget

`sim/seed.ts` gives a file 5 s of CPU time for all its seeds, its wall time
reported beside it, never judged: nothing here waits on a real clock, so on a
quiet host the wall time is the CPU time, and on a loaded one it is the
host's. A boot is judged the same way: it fails past 4 s of CPU time
(`sim-tui boot <file>: cpu … of its 4000, wall …`; only a process's first boot
comes near it, the Solid transform of the fork's TUI); a file's seeds are
reported at its close (`sim-tui seeds <file>: …`). A seed costs 0.2–0.25 s of
CPU (all threads: the JIT's helper threads run beside it), so a file runs the seed count
that leaves a fifth of its budget free: 16 for prime-escape and prime-sidebar,
3 a case for escape-states' five cases.

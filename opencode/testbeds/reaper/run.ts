// The reaper testbeds/reaper/start.ts starts, one per test process, in a process group of its own. It samples the
// process table every 500 ms and keeps every process descended from its owner (`REAPER_OWNER`, the test
// process), so it still knows one handed to pid 1: a background service `service start` made, an
// opencode-drive TUI in a group of its own. Once the owner is gone (the same pid and start time no longer in
// the table), whether it exited, timed out or was killed with SIGKILL and ran no cleanup of its own, it stops
// each of them still running, frozen first with what they started since its last sample (`freeze`), with
// SIGKILL, and ends. Only the owner's
// descendants are ever named, the reaper itself aside, so nothing the test did not start is touched.
//
// With `REAPER_SEEN` set to a file, it writes there the pids it has seen after each sample: tests/reaper.test.ts
// waits on it before it kills its runner.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Config, Effect, FileSystem, Option, Schedule } from "effect"
import { descendants, type Proc, signal, survivors, table } from "../../scripts/leaks.ts"

/**
 * How often the table is sampled while the owner lives. A process handed to pid 1 sooner than this after its
 * start goes unseen; a service is its starter's child until it serves (the fork's client waits, ~1.6 s).
 */
const EVERY = "500 millis"
/** The reaper's own command line: never one of the processes it stops. */
const REAPER = /testbeds\/reaper\/run\.ts/

/** Samples the owner's descendants into `seen`, and names them in `report` when there is one; whether the owner still runs. */
const sample = (owner: Proc, seen: Map<string, Proc>, report: Option.Option<string>) =>
  Effect.gen(function* () {
    const rows = table()
    for (const proc of descendants(rows, owner.pid)) if (!REAPER.test(proc.args)) seen.set(`${proc.pid} ${proc.started}`, proc)
    const fs = yield* FileSystem.FileSystem
    yield* Effect.forEach(Option.toArray(report), (file) => fs.writeFileString(file, [...seen.values()].map((proc) => `${proc.pid}\n`).join("")))
    return survivors([owner], rows).length > 0
  })

/** How many rounds the freeze takes at most: each finds the children of the last round's. */
const ROUNDS = 10

/**
 * Freezes `procs` (SIGSTOP) and, round by round, the children they had started since the last sample (a
 * `service restart` starting the new service as its owner died), until a round finds none: a frozen process
 * starts nothing more. The frozen set, to be stopped.
 */
const freeze = (procs: ReadonlyArray<Proc>) =>
  Effect.sync(() => {
    const frozen = new Map(procs.map((proc) => [`${proc.pid} ${proc.started}`, proc]))
    for (let round = 0, fresh = [...procs]; round < ROUNDS && fresh.length > 0; round++) {
      signal(fresh, "SIGSTOP")
      const rows = table()
      fresh = [...frozen.values()].flatMap((proc) => descendants(rows, proc.pid)).filter((proc) => !frozen.has(`${proc.pid} ${proc.started}`) && !REAPER.test(proc.args))
      for (const proc of fresh) frozen.set(`${proc.pid} ${proc.started}`, proc)
    }
    return [...frozen.values()]
  })

const program = Effect.gen(function* () {
  const pid = yield* Config.Int("REAPER_OWNER")
  const report = yield* Config.option(Config.String("REAPER_SEEN"))
  // An owner already gone has nothing of its own left to sample: sh's $PPID is 1 when the test process ended
  // before the reaper started, and pid 1 never goes.
  const owner = Arr.findFirst(table(), (row) => row.pid === pid && pid > 1)
  if (Option.isNone(owner)) return
  const seen = new Map<string, Proc>()
  yield* Effect.repeat(sample(owner.value, seen, report), { while: (alive) => alive, schedule: Schedule.spaced(EVERY) })
  const doomed = yield* freeze(survivors([...seen.values()], table()))
  // SIGKILL, frozen: a process given a SIGTERM may start another first (a TUI whose service ends starts a new one,
  // seen in a reconnect run), and the reaper is the last resort, after the test's own graceful cleanup could not run.
  yield* Effect.sync(() => signal(doomed, "SIGKILL"))
})

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer), Effect.orDie))

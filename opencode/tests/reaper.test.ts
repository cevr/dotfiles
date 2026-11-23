// testbeds/reaper/start.ts: a test runner killed with SIGKILL mid-run (no finalizer, no exit hook) leaves nothing it
// started. tests/reaper/runner.ts imports the reaper as tests/owned.ts and tests/service.ts do, starts a process
// handed to pid 1 (a `service start` daemon), one leading a group of its own (an opencode-drive TUI) and one that
// starts another when told to stop (a TUI whose service ends), and is killed once its reaper has seen them; all
// end within the reaper's sample, nothing new starts, and the reaper ends too. And a process that ends before its
// reaper starts leaves no reaper behind. Batch cx found two reconnect tests' services and a wake test's TUI under
// pid 1 a day after their runs.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Schedule, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Proc, signal, stop, survivors, table } from "../scripts/leaks.ts"

/** The pid a `<label> <pid>` line of the runner names; 0 when none does. */
const pidOf = (lines: ReadonlyArray<string>, label: string) =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(lines, (line) => line.startsWith(`${label} `)),
      (line) => Number(line.slice(label.length + 1)),
    ),
    () => 0,
  )

/** `check` every 100 ms until it holds or 10 s (the reaper's sample and a margin) went by; its last answer. */
const within = <A, R>(check: Effect.Effect<A, never, R>, holds: (value: A) => boolean) =>
  Effect.repeat(check, { until: holds, schedule: Schedule.spaced("100 millis"), times: 100 })

/** A process's command line and environment, as `ps` lists them (BSD and procps `e`); "" once it is gone. */
const environ = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const ps = yield* spawner.spawn(ChildProcess.make("ps", ["eww", "-o", "command=", "-p", `${pid}`], { stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second" }))
    return yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString)
  }).pipe(Effect.scoped, Effect.orElseSucceed(() => ""))

/** The reapers running whose environment names `seen` (`REAPER_SEEN`): this case's, none of another run's. */
const reapersOf = (seen: string) =>
  Effect.sync(() => table().filter((row) => row.args.includes("testbeds/reaper/run.ts"))).pipe(
    Effect.flatMap((rows) => Effect.filter(rows, (row) => Effect.map(environ(row.pid), (text) => text.includes(`REAPER_SEEN=${seen}`)))),
  )

/** `bun <script>` with `REAPER_SEEN` naming `seen`. */
const bunWith = (script: string, seen: string) =>
  ChildProcess.make("bun", [script], { detached: true, stdin: "ignore", stderr: "inherit", env: { REAPER_SEEN: seen }, extendEnv: true, forceKillAfter: "1 second" })

/** A scratch file for a case's reaper to name what it sees: its path also tells this case's reapers apart. */
const seenFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "reaper-" }), "seen")
})

/** The path of a file beside this one. */
const beside = (name: string) => Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL(name, import.meta.url)))

describe("the reaper of a test process", () => {
  it.live.layer(BunServices.layer)(
    "a runner killed with SIGKILL mid-run leaves no process it started: a daemon handed to pid 1, a child in its own group, one that starts another on SIGTERM, the reaper",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const seen = yield* seenFile
        // Its own group: the kill below is for the runner alone, as a SIGKILL of a test process is.
        const child = yield* spawner.spawn(bunWith(yield* beside("./reaper/runner.ts"), seen))
        const lines = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.takeUntil((line) => line.startsWith("child ")),
          Stream.runCollect,
        )
        const pids = [pidOf(lines, "daemon"), pidOf(lines, "respawner"), pidOf(lines, "child")]
        const started = table().filter((row) => pids.includes(row.pid))
        expect(started.length).toBe(3)
        // The kill once the reaper has seen them all (or, with no reaper, once it would have).
        const named = fs.readFileString(seen).pipe(Effect.orElseSucceed(() => ""))
        yield* within(named, (text) => pids.every((pid) => text.split("\n").includes(`${pid}`)))
        const reapers = yield* reapersOf(seen)
        yield* child.kill({ killSignal: "SIGKILL" })
        const orphans: ReadonlyArray<Proc> = yield* within(
          Effect.sync(() => survivors([...started, ...reapers], table())),
          (alive) => alive.length === 0,
        )
        // Whatever a failed run left, the test stops: it started them. SIGKILL, not a SIGTERM the respawner would
        // answer with one more; and the one a reaper's SIGTERM made it start, named in its file, goes too.
        yield* Effect.sync(() => signal(orphans, "SIGKILL"))
        const respawned = Number((yield* fs.readFileString(`${seen}.respawned`).pipe(Effect.orElseSucceed(() => ""))).trim())
        const spawned = table().filter((row) => row.pid === respawned && row.args === "sleep 122")
        yield* Effect.sync(() => signal(spawned, "SIGKILL"))
        expect([reapers.length, orphans.map((proc) => proc.args)]).toEqual([1, []])
        // The respawner was never told to stop: it started nothing on its way out.
        expect(spawned.map((row) => row.args)).toEqual([])
      }).pipe(Effect.scoped),
    40_000,
  )

  it.live.layer(BunServices.layer)(
    "the reaper of a process that ended before it started (its owner read as pid 1) ends too, and a plain bun script that starts one is not held open by it",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const seen = yield* seenFile
        const quick = yield* beside("./reaper/quick.ts")
        for (const _ of [1, 2, 3, 4, 5]) {
          const child = yield* spawner.spawn(bunWith(quick, seen))
          expect(Option.map(yield* child.exitCode.pipe(Effect.timeoutOption("5 seconds")), Number)).toEqual(Option.some(0))
        }
        const left = yield* within(reapersOf(seen), (rows) => rows.length === 0)
        yield* Effect.promise(() => stop(left))
        expect(left.map((row) => row.args)).toEqual([])
      }).pipe(Effect.scoped),
    40_000,
  )
})
// @reads all

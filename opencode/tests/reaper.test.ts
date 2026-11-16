// testbeds/reaper/start.ts: a test runner killed with SIGKILL mid-run (no finalizer, no exit hook) leaves nothing it
// started: tests/reaper/runner.ts imports the reaper as tests/owned.ts and tests/service.ts do, starts a process
// handed to pid 1 (a `service start` daemon) and one leading a group of its own (an opencode-drive TUI), and is
// killed once its reaper has seen both; both end within the reaper's sample and grace, and so does the reaper.
// Batch cx found two reconnect tests' services and a wake test's TUI under pid 1 a day after their runs.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Schedule, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { descendants, type Proc, stop, survivors, table } from "../scripts/leaks.ts"

/** The pid a `<label> <pid>` line of the runner names; 0 when none does. */
const pidOf = (lines: ReadonlyArray<string>, label: string) =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(lines, (line) => line.startsWith(`${label} `)),
      (line) => Number(line.slice(label.length + 1)),
    ),
    () => 0,
  )

/** `check` every 100 ms until it holds or 10 s (the reaper's sample, its grace and a margin) went by; its last answer. */
const within = <A>(check: Effect.Effect<A>, holds: (value: A) => boolean) =>
  Effect.repeat(check, { until: holds, schedule: Schedule.spaced("100 millis"), times: 100 })

describe("the reaper of a test process", () => {
  it.live.layer(BunServices.layer)(
    "a runner killed with SIGKILL mid-run leaves no process it started: a daemon handed to pid 1, a child in its own group, the reaper",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const runner = yield* path.fromFileUrl(new URL("./reaper/runner.ts", import.meta.url))
        const seen = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "reaper-" }), "seen")
        // Its own group: the kill below is for the runner alone, as a SIGKILL of a test process is.
        const command = ChildProcess.make("bun", [runner], { detached: true, stdin: "ignore", stderr: "inherit", env: { REAPER_SEEN: seen }, extendEnv: true, forceKillAfter: "1 second" })
        const child = yield* spawner.spawn(command)
        const lines = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.takeUntil((line) => line.startsWith("child ")),
          Stream.runCollect,
        )
        const pids = [pidOf(lines, "daemon"), pidOf(lines, "child")]
        const started = table().filter((row) => pids.includes(row.pid))
        const reapers = descendants(table(), child.pid).filter((row) => row.args.includes("testbeds/reaper/run.ts"))
        expect(started.length).toBe(2)
        // The kill once the reaper has seen both (or, with no reaper, once it would have).
        const named = fs.readFileString(seen).pipe(Effect.orElseSucceed(() => ""))
        yield* within(named, (text) => pids.every((pid) => text.split("\n").includes(`${pid}`)))
        yield* child.kill({ killSignal: "SIGKILL" })
        const orphans: ReadonlyArray<Proc> = yield* within(
          Effect.sync(() => survivors([...started, ...reapers], table())),
          (alive) => alive.length === 0,
        )
        // Whatever a failed run left, the test stops: it started them.
        yield* Effect.promise(() => stop(orphans))
        expect(orphans.map((proc) => proc.args)).toEqual([])
      }).pipe(Effect.scoped),
    40_000,
  )
})

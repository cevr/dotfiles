// Isolation of the seeds that share one app: a seed run alone (`SIM_SEED=<n>`,
// its file booting a fresh app for it) gives the same trace as that seed in
// the file's full run, after every seed before it, for three seeds of each
// simulated TUI file. A seed that left something behind in the app (a
// toast, a session still running, a timer's phase, a draft) shows here as a
// trace that depends on what ran before it.
//
// Each run is a `bun test` of its own, in a process group of its own, stopped
// with its group if it outlives RUN_MS or when its test ends.
import { describe, expect } from "bun:test"
import { Data, Effect, Fiber, FileSystem, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TRACE_ENV } from "./app.ts"
import { platformTest } from "./effect-test.ts"

// Each file's seeds checked alone. In prime-escape and prime-sidebar every test reads one play a seed, so seed 1
// is the first after the boot in both runs and seeds 2 to 4 are the ones a seed before could reach. escape-states
// runs 2 seeds, each test its own play: its seed 1 of every test but the first follows the test before, and its
// seed 2 follows seed 1; both are checked, every seed it has.
const FILES = new Map([
  ["cmd/prime/prime-escape.sim.test.tsx", [2, 3, 4]],
  ["cmd/prime/prime-sidebar.sim.test.tsx", [2, 3, 4]],
  ["cmd/escape/escape-states.sim.test.tsx", [1, 2]],
])
const RUN_MS = 300_000

/** A run of a file that did not pass. */
class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string }> {}

/** Runs `file` with `seed` alone (or every seed), writing its seeds' traces to a new folder; returns the folder. */
const run = (file: string, seed: Option.Option<number>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
    const traces = yield* fs.makeTempDirectoryScoped({ prefix: "sim-tui-isolation-" })
    const env = Option.match(seed, { onNone: () => ({ [TRACE_ENV]: traces }), onSome: (one) => ({ [TRACE_ENV]: traces, SIM_SEED: String(one) }) })
    const command = ChildProcess.make(process.execPath, ["test", "--timeout", String(RUN_MS), `./${file}`], {
      cwd: root,
      env,
      extendEnv: true,
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    })
    // The child runs in a process group of its own; the scope's end stops the group.
    const child = yield* spawner.spawn(command)
    const errors = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
    const code = yield* child.exitCode.pipe(Effect.timeoutOption(RUN_MS))
    if (Option.isSome(code) && code.value === 0) return traces
    const said = yield* Fiber.join(errors).pipe(Effect.timeoutOption("5 seconds"), Effect.orElseSucceed(() => Option.none<string>()))
    const tail = Option.getOrElse(said, () => "").slice(-2_000)
    return yield* new RunFailed({ message: `${file} ${Option.match(seed, { onNone: () => "(every seed)", onSome: (one) => `SIM_SEED=${one}` })} exited ${Option.getOrElse(code, () => "none: past its time")}:\n${tail}` })
  })

/** Each trace file in `dir`, by name. */
const read = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(dir)
    return new Map(yield* Effect.forEach(names, (name) => Effect.map(fs.readFileString(path.join(dir, name)), (trace) => [name, trace] as const)))
  })

describe("seeds alone give the traces they give in the full run", () => {
  for (const [file, alone] of FILES)
    platformTest(
      `${file}: seeds ${alone.join(", ")} alone give the traces they give in the full run`,
      Effect.gen(function* () {
        const everyone = yield* read(yield* run(file, Option.none()))
        for (const seed of alone) {
          const traces = yield* read(yield* run(file, Option.some(seed)))
          expect(traces.size).toBeGreaterThan(0)
          for (const [name, trace] of traces) expect({ name, trace }).toEqual({ name, trace: everyone.get(name) ?? "(not in the full run)" })
        }
      }),
      RUN_MS * (alone.length + 1),
    )
})

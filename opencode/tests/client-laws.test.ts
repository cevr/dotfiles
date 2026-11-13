// The client laws (sim-tui/client-laws.ts) in real OpenCode: one boot of the
// fork's embedded host (tests/client-laws/real.ts) in a scratch home, on a
// scripted model, every law run on it over the host's own fetch. Each law is
// one test, under the name it has on the double (sim-tui/client-laws.test.ts):
// what the double does for the TUI, real OpenCode does too. It needs
// OPENCODE_DEV (the fork), as every real acceptance run has it.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Deferred, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { LAWS } from "../sim-tui/client-laws.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
/** How long the real boot and its laws may take before they are stopped. */
const BOOT = "6 minutes"
const Outcome = Schema.Struct({ name: Schema.String, failures: Schema.Array(Schema.String) })
const Result = Schema.fromJsonString(Schema.Struct({ outcomes: Schema.Array(Outcome) }))
type Outcome = typeof Outcome.Type

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** Each law's outcome from one real run; a failed run is a run that says how it failed. */
const boot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fork = yield* Config.String("OPENCODE_DEV")
  const search = yield* Config.String("PATH")
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "client-laws-e2e-" })
  const home = path.join(base, "home")
  const temp = path.join(base, "tmp")
  yield* fs.makeDirectory(home)
  yield* fs.makeDirectory(temp)
  const command = ChildProcess.make(process.execPath, [path.join(ROOT, "tests/client-laws/real.ts")], {
    cwd: ROOT,
    env: {
      PATH: search,
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      SIM_REAL_BASE: base,
      SIM_REAL_FORK: path.resolve(fork),
    },
    extendEnv: false,
    stdin: "ignore",
    forceKillAfter: "3 seconds",
  })
  // The child runs in a process group of its own; the scope's end stops the group.
  const child = yield* spawner.spawn(command)
  const output = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 }).pipe(Effect.forkScoped)
  const code = yield* child.exitCode.pipe(Effect.timeoutOption(BOOT))
  const result = path.join(base, "result.json")
  const done = Option.isSome(code) && code.value === 0 && (yield* fs.exists(result))
  if (!done) {
    const said = yield* Fiber.join(output).pipe(Effect.timeoutOption("5 seconds"))
    const [stdout, stderr] = Option.getOrElse(said, () => ["", ""])
    const failed: Run = { failed: Option.some(`the real run failed (exit ${Option.getOrElse(code, () => "none: it ran past its time")}):\n${stdout}\n${stderr}`), outcomes: [] }
    return failed
  }
  const read = yield* fs.readFileString(result).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Result)))
  const ran: Run = { failed: Option.none(), outcomes: read.outcomes }
  return ran
}).pipe(
  Effect.scoped,
  Effect.catch((error) => Effect.succeed<Run>({ failed: Option.some(`the real run failed: ${String(error)}`), outcomes: [] })),
)

interface Run {
  readonly failed: Option.Option<string>
  readonly outcomes: ReadonlyArray<Outcome>
}

/** The one run, shared by every law's test: the first test starts it, the rest wait for it. */
const shared = { run: Option.none<Deferred.Deferred<Run>>() }
const outcomes = Effect.gen(function* () {
  if (Option.isSome(shared.run)) return yield* Deferred.await(shared.run.value)
  const started = yield* Deferred.make<Run>()
  shared.run = Option.some(started)
  yield* Deferred.complete(started, boot)
  return yield* Deferred.await(started)
})

/** A law's failures in the run: the run's own failure when it did not finish, none past its outcome. */
const failuresOf = (run: Run, name: string) =>
  Option.match(run.failed, {
    onSome: (failed) => [failed],
    onNone: () => Option.match(Option.fromUndefinedOr(run.outcomes.find((outcome) => outcome.name === name)), { onNone: () => [`no outcome for ${name}`], onSome: (outcome) => outcome.failures }),
  })

describe("the client laws in real OpenCode", () => {
  const live = it.live.layer(BunServices.layer)
  for (const law of LAWS)
    live(
      law.name,
      () =>
        Effect.gen(function* () {
          expect(failuresOf(yield* outcomes, law.name)).toEqual([])
        }),
      400_000,
    )
})

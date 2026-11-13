// The host laws (sim/host-laws.ts) in real OpenCode: one boot of the fork
// through its SDK (tests/host-laws/real.ts) in a scratch home, on a scripted
// model, with the law probe (sim/server.ts) loaded from config. Each law is one
// test, under the name it has on the world (sim/host-laws.test.ts): what the
// world does for a plugin, real OpenCode does too. It needs OPENCODE_DEV (the
// fork), as every real acceptance run has it.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Deferred, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { KEPT, NAMES, outcome } from "../sim/law-names.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
/** How long the real boot may take before it is stopped. */
const BOOT = "6 minutes"
const Result = Schema.fromJsonString(Schema.Struct({ lines: Schema.Array(Schema.String) }))

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** The probe's outcome lines from one real boot; a failed run is one line that says how it failed. */
const boot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fork = yield* Config.String("OPENCODE_DEV")
  const search = yield* Config.String("PATH")
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "host-laws-e2e-" })
  const home = path.join(base, "home")
  const temp = path.join(base, "tmp")
  yield* fs.makeDirectory(home)
  yield* fs.makeDirectory(temp)
  const command = ChildProcess.make(process.execPath, [path.join(ROOT, "tests/host-laws/real.ts")], {
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
      SIM_REAL_PROBE: path.join(ROOT, "sim"),
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
    return [`the real run failed (exit ${Option.getOrElse(code, () => "none: it ran past its time")}):\n${stdout}\n${stderr}`]
  }
  return (yield* fs.readFileString(result).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Result)))).lines
}).pipe(
  Effect.scoped,
  Effect.catch((error) => Effect.succeed([`the real run failed: ${String(error)}`])),
)

/** The one boot, shared by every law's test: the first test starts it, the rest wait for its lines. */
const shared = { boot: Option.none<Deferred.Deferred<ReadonlyArray<string>>>() }
const lines = Effect.gen(function* () {
  if (Option.isSome(shared.boot)) return yield* Deferred.await(shared.boot.value)
  const started = yield* Deferred.make<ReadonlyArray<string>>()
  shared.boot = Option.some(started)
  yield* Deferred.complete(started, boot)
  return yield* Deferred.await(started)
})

describe("the host laws in real OpenCode", () => {
  const live = it.live.layer(BunServices.layer)
  for (const name of NAMES)
    live(
      name,
      () =>
        Effect.gen(function* () {
          expect(outcome(yield* lines, name)).toEqual([`${KEPT}${name}`])
        }),
      400_000,
    )
})

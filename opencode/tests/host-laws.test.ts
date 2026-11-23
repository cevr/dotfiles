// @reads sim
// @reads-indirect sim/**
// accept: one at a time (it bounds a failed probe load's boot under 60 s).
// The host laws (sim/host-laws.ts) in real OpenCode: one boot of the fork
// through its SDK (tests/host-laws/real.ts) in a scratch home, on a scripted
// model, with the law probe (sim/server.ts) loaded from config. Each law is one
// test, under the name it has on the world (sim/host-laws.test.ts): what the
// world does for a plugin, real OpenCode does too. It needs OPENCODE_DEV (the
// fork), as every real acceptance run has it.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Config, Deferred, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcessSpawner } from "effect/process"
import { NO_FREE_MODELS, releaseFlags } from "../scripts/release-flags.ts"
import { KEPT, NAMES, outcome } from "../sim/law-names.ts"
import { scratchInput } from "./read-path.ts"
import { checkoutBunCommand } from "./scratch-child.ts"
import { scratchRoot } from "./scratch.ts"

/** How long the real boot may take before it is stopped. */
const BOOT = "6 minutes"
const Result = Schema.fromJsonString(Schema.Struct({ lines: Schema.Array(Schema.String) }))

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** One real boot with the checkout probe, or a generated probe for the load-failure control. */
const boot = (scratchProbe?: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fork = yield* Config.String("OPENCODE_DEV")
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "host-laws-e2e-" })
  const home = path.join(base, "home")
  yield* fs.makeDirectory(home)
  const scratch = {
    HOME: home, TMPDIR: scratchRoot(), SIM_REAL_BASE: base,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
  const external = { SIM_REAL_FORK: path.resolve(fork) }
  // The runner starts the fork in its own process, with the owner's build's flags.
  const values = { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_FLAGS: releaseFlags(""), ...NO_FREE_MODELS }
  const command = (scratchProbe && checkoutBunCommand("tests/host-laws/real.ts", { scratch: { ...scratch, SIM_REAL_PROBE: scratchProbe }, external, values }))
    || checkoutBunCommand("tests/host-laws/real.ts", { scratch, external, values, checkout: { SIM_REAL_PROBE: "sim" } })
  // The child runs in a process group of its own; the scope's end stops the group.
  const child = yield* spawner.spawn(command)
  const output = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 }).pipe(Effect.forkScoped)
  const code = yield* child.exitCode.pipe(Effect.timeoutOption(BOOT))
  const result = path.join(base, "result.json")
  const done = Option.isSome(code) && code.value === 0 && (yield* fs.exists(scratchInput(result)))
  if (!done) {
    const said = yield* Fiber.join(output).pipe(Effect.timeoutOption("5 seconds"))
    const [stdout, stderr] = Option.getOrElse(said, () => ["", ""])
    return [`the real run failed (exit ${Option.getOrElse(code, () => "none: it ran past its time")}):\n${stdout}\n${stderr}`]
  }
  return (yield* fs.readFileString(scratchInput(result)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Result)))).lines
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
  yield* Deferred.complete(started, boot())
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

  live(
    "a probe the host cannot load ends the run within a minute, naming the load failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const probe = yield* fs.makeTempDirectoryScoped({ prefix: "host-laws-unloadable-" })
        yield* fs.writeFileString(`${probe}/package.json`, '{"name":"host-laws-unloadable","type":"module","exports":{"./server":"./server.ts"}}')
        yield* fs.writeFileString(`${probe}/server.ts`, 'import "@dotfiles/no-such-package-x"\nexport default {}\n')
        const from = yield* Clock.currentTimeMillis
        const said = yield* boot(probe)
        const took = (yield* Clock.currentTimeMillis) - from
        expect({ lines: said.length, unloaded: said.join("\n").includes(`the host did not load the probe (${probe})`), named: said.join("\n").includes("no-such-package-x") }).toEqual({ lines: 1, unloaded: true, named: true })
        expect(took).toBeLessThan(60_000)
      }).pipe(Effect.scoped),
    400_000,
  )
})

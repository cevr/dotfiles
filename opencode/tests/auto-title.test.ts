// @reads all
// @reads-reason subprocess reads at tests/auto-title.test.ts: const command = ChildProcess.make(process.execPath, [path.join(ROOT, "tests/auto-title/run.ts")
// Auto-title in real OpenCode: one boot of the fork through its SDK
// (tests/auto-title/run.ts) in a scratch home, on a scripted model, with the
// plugin loaded from config, due after 0 minutes and 2 turns. An idle root
// session past the threshold gets a title generated again through OpenCode's
// own title path; one the owner renamed keeps the owner's title through as
// many turns; the owner's `/rename` with no argument unpins it. It needs
// OPENCODE_DEV (the fork, with the plugin `session.update` generating a title
// for an empty one: `feat/plugin-title-regenerate`). The trigger rule is tested
// on the test clock in cmd/auto-title/model.test.ts.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Result, titleOf } from "./auto-title/names.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
/** How long the real run may take before it is stopped. */
const LIMIT = "2 minutes"

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** The run's result, from one real boot; a failed run fails with its output. */
const boot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fork = yield* Config.String("OPENCODE_DEV")
  const search = yield* Config.String("PATH")
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "auto-title-e2e-" })
  const home = path.join(base, "home")
  const temp = path.join(base, "tmp")
  yield* fs.makeDirectory(home)
  yield* fs.makeDirectory(temp)
  const command = ChildProcess.make(process.execPath, [path.join(ROOT, "tests/auto-title/run.ts")], {
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
      AUTO_TITLE_BASE: base,
      AUTO_TITLE_FORK: path.resolve(fork),
      AUTO_TITLE_PLUGIN: path.join(ROOT, "cmd/auto-title"),
    },
    extendEnv: false,
    stdin: "ignore",
    forceKillAfter: "3 seconds",
  })
  // The child runs in a process group of its own; the scope's end stops the group.
  const child = yield* spawner.spawn(command)
  const output = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 }).pipe(Effect.forkScoped)
  const code = yield* child.exitCode.pipe(Effect.timeoutOption(LIMIT))
  const result = path.join(base, "result.json")
  if (Option.isSome(code) && code.value === 0 && (yield* fs.exists(result)))
    return yield* fs.readFileString(result).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Result))))
  const said = Option.getOrElse(yield* Fiber.join(output).pipe(Effect.timeoutOption("5 seconds")), () => ["", ""])
  return yield* Effect.die(`the real run failed (exit ${Option.getOrElse(code, () => "none: it ran past its time")}):\n${said.join("\n")}`)
}).pipe(Effect.scoped)

describe("auto-title in real OpenCode", () => {
  it.live.layer(BunServices.layer)(
    "an idle root session past the threshold is retitled, a pinned one is not until the owner asks for a generated title",
    () =>
      Effect.gen(function* () {
        const result = yield* boot
        expect(result.titles).toEqual({
          "alpha first": titleOf("alpha", 1),
          "alpha after turns": titleOf("alpha", 2),
          "beta first": titleOf("beta", 1),
          "beta pinned": "The owner's name",
          "beta regenerated": titleOf("beta", 2),
          "beta unpinned": titleOf("beta", 3),
        })
        expect(result.requests).toEqual({ alpha: 2, beta: 3 })
        expect(result.log).toContain("auto-title: the owner set the title: pinned")
        expect(result.log).toContain("auto-title: the owner asked for a generated title: unpinned")
        expect(result.log.filter((line) => line === "auto-title: generating the title again")).toHaveLength(2)
      }),
    150_000,
  )
})

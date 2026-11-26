// @reads all
// @reads-reason subprocess reads at tests/host-admit-cli.test.ts: the stub runs real commands
// host-admit after the admission gate was removed: a stub. Any form with a
// `--` runs what follows it as written and exits with its code, printing
// nothing of its own; `host status --json` reads the host now; every other
// form exits 2.
import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Effect, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { it } from "effect-bun-test"
import { hangGuard } from "./hang-guard.ts"

const [bun = "bun"] = argv
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** host-admit run on `args`: what it printed on each stream, and its exit code. */
const cli = (args: ReadonlyArray<string>) => Effect.gen(function* () {
  const path = yield* Path.Path
  const entry = yield* path.fromFileUrl(new URL("../cmd/guard/host-admit.ts", import.meta.url))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make(bun, [entry, ...args], { stdin: "ignore", forceKillAfter: "5 seconds" }))
  const [out, err, code] = yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], { concurrency: 3 })
  return { out, err, code: Number(code) }
}).pipe(Effect.scoped, Effect.provide(BunServices.layer))

const Status = Schema.Struct({
  version: Schema.Literal(2),
  cores: Schema.Int,
  load: Schema.Struct({ one: Schema.Finite, five: Schema.Finite, fifteen: Schema.Finite }),
  memory: Schema.Struct({ totalBytes: Schema.Int, freeBytes: Schema.Int }),
  disk: Schema.Struct({ path: Schema.String, totalBytes: Schema.Int, freeBytes: Schema.Int }),
})
const status = Schema.decodeUnknownSync(Schema.fromJsonString(Status))

describe("host-admit, the stub", () => {
  it.effect("runs the command after `--` as written, argv and all, prints nothing of its own and exits with its code", () => Effect.gen(function* () {
    const ran = yield* cli(["check", "run", "--class", "check", "--width", "4", "--", "sh", "-c", 'printf "%s|" "$@"; exit 7', "zero", "a b", "--", "c"])
    expect(ran).toEqual({ out: "a b|--|c|", err: "", code: 7 })
    expect(yield* cli(["lease", "run", "--id", "x", "--", "true"])).toEqual({ out: "", err: "", code: 0 })
  }), hangGuard("local-fixture"))

  it.effect("a nested prefix runs the innermost command once", () => Effect.gen(function* () {
    const path = yield* Path.Path
    const entry = yield* path.fromFileUrl(new URL("../cmd/guard/host-admit.ts", import.meta.url))
    expect(yield* cli(["check", "run", "--", bun, entry, "check", "run", "--width", "2", "--", "printf", "once"])).toEqual({ out: "once", err: "", code: 0 })
  }).pipe(Effect.provide(BunServices.layer)), hangGuard("local-fixture"))

  it.effect("a command a signal ends exits 128 + the signal; one that cannot start exits 127", () => Effect.gen(function* () {
    expect((yield* cli(["check", "run", "--", "sh", "-c", "kill -KILL $$"])).code).toBe(137)
    expect((yield* cli(["check", "run", "--", "/nonexistent/loop-probe-x"])).code).toBe(127)
  }), hangGuard("local-fixture"))

  it.effect("host status --json reads the host now: cores, load, memory and the disk here", () => Effect.gen(function* () {
    const ran = yield* cli(["host", "status", "--json"])
    expect(ran.code).toBe(0)
    const read = status(ran.out)
    expect([read.cores > 0, read.memory.totalBytes > 0, read.disk.totalBytes >= read.disk.freeBytes, read.disk.freeBytes > 0]).toEqual([true, true, true, true])
  }), hangGuard("local-fixture"))

  it.effect("every other form exits 2 and names what it takes; --version and --help exit 0", () => Effect.gen(function* () {
    for (const args of [["lease", "request", "--json"], ["holder", "list", "--json"], ["check", "run", "--"], []]) {
      const ran = yield* cli(args)
      expect([args, ran.out, ran.code, ran.err.includes("runs COMMAND as written")]).toEqual([args, "", 2, true])
    }
    expect(yield* cli(["--version"])).toEqual({ out: "host-admit 2\n", err: "", code: 0 })
    expect((yield* cli(["--help"])).code).toBe(0)
  }), hangGuard("local-fixture"))
})

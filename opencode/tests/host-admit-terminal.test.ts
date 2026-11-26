// @reads all
// @reads-reason subprocess reads at tests/host-admit-terminal.test.ts: the stub runs real commands with the caller's streams
// host-admit, the stub, in a terminal's place: the command reads the
// caller's stdin and writes its stdout, and a signal sent to host-admit
// reaches the command, whose own exit then stands.
import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Effect, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { it } from "effect-bun-test"
import { hangGuard } from "./hang-guard.ts"

const [bun = "bun"] = argv
const started = (args: ReadonlyArray<string>, stdin: ChildProcess.CommandInput) => Effect.gen(function* () {
  const path = yield* Path.Path
  const entry = yield* path.fromFileUrl(new URL("../cmd/guard/host-admit.ts", import.meta.url))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.spawn(ChildProcess.make(bun, [entry, ...args], { stdin, stderr: "ignore", forceKillAfter: "5 seconds" }))
})

describe("host-admit, the stub, as a terminal sees it", () => {
  it.effect("the command reads the caller's stdin and writes to its stdout", () => Effect.gen(function* () {
    const child = yield* started(["check", "run", "--width", "1", "--", "cat"], Stream.make(new TextEncoder().encode("typed\nlines\n")))
    const [out, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
    expect({ out, code: Number(code) }).toEqual({ out: "typed\nlines\n", code: 0 })
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)), hangGuard("local-fixture"))

  it.effect("a SIGTERM to host-admit reaches the command, and the command's exit stands", () => Effect.gen(function* () {
    const script = 'trap "echo stopped; exit 5" TERM; echo ready; while :; do sleep 0.1; done'
    const child = yield* started(["check", "run", "--", "sh", "-c", script], "ignore")
    const lines = child.stdout.pipe(Stream.decodeText(), Stream.splitLines)
    // Once the command says it is ready, host-admit is sent SIGTERM; the command's trap answers it.
    const said = yield* lines.pipe(
      Stream.tap((line) => Effect.when(child.kill({ killSignal: "SIGTERM" }), Effect.succeed(line === "ready"))),
      Stream.runCollect,
    )
    expect({ said, code: Number(yield* child.exitCode) }).toEqual({ said: ["ready", "stopped"], code: 5 })
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)), hangGuard("local-fixture"))
})

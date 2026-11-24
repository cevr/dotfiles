import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Effect, Option, Schema } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { readScratchFileSync } from "../../tests/read-path.ts"
import { exitCodeOf, hostRefusal, type Input, Refused, restartCommand } from "../restart-leg.ts"

const Arguments = Schema.fromJsonString(Schema.Array(Schema.String))
const preflightOnly = Effect.fn("RestartLeg.fixture")(function* (input: Input) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const system = yield* spawner.string(ChildProcess.make("/usr/bin/uname", ["-s"], { stdin: "ignore", forceKillAfter: "1 second" }))
  return yield* new Refused({
    reason: Option.getOrElse(hostRefusal(input, system.trim()), () => "the fixture cannot launch the live leg"),
  })
})

BunRuntime.runMain(Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(Arguments)(readScratchFileSync(argv[2] || "", "utf8"))
  yield* Command.runWith(restartCommand(preflightOnly), { version: "1.0.0" })(args)
}).pipe(Effect.provide(BunServices.layer)), { disableErrorReporting: true, teardown: (exit, onExit) => onExit(exitCodeOf(exit)) })

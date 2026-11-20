// A test process started under a bound build (scripts/bound-env.test.ts starts it with a binding): it
// runs `/usr/bin/env` through tests/owned.ts with its whole environment, as a test spreads
// process.env for its child, and prints what that child got.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Stream } from "effect"
import { owned } from "../tests/owned.ts"
import { parentEnv } from "../tests/scratch.ts"

const program = Effect.gen(function* () {
  const child = owned(["/usr/bin/env"], { env: { ...parentEnv }, stdout: "pipe" })
  const text = yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(Stream.decodeText(), Stream.mkString)
  yield* Effect.promise(() => child.exited)
  yield* Console.log(text)
})

BunRuntime.runMain(program)

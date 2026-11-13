// accept: one at a time (it bounds by the clock how soon a deep run gives the accept lock up and takes it back).
// The wall-clock bounds of scripts/accept.test.ts's real runs of scripts/accept.ts. In the gate those runs
// judge what happened and in what order, never how fast: a loaded host stretches real time many times over,
// and a gate unit test does not judge it. Here, one at a time, ACCEPT_TIMED=1 makes the same runs judge their
// clock bounds too: a land run ends near its budget; the lock is free within 5 s of a land run's mark; a deep
// run takes the lock back within 2 s of the marking land run's death; a land run takes the lock of a killed deep
// run at once.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** The real runs of scripts/accept.test.ts that carry a clock bound. */
const TIMED_RUNS = "a land run under its budget|a deep run yields the lock to a land run"

/** How many tests TIMED_RUNS names: a filter that matched fewer would judge less. */
const TIMED_COUNT = 4

/** The timed runs' bun test, from opencode/, with its output and its exit code. */
const timedRuns = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make("bun", ["test", "./scripts/accept.test.ts", "-t", TIMED_RUNS], { env: { ACCEPT_TIMED: "1" }, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }),
  )
  const out = yield* child.all.pipe(Stream.decodeText(), Stream.mkString)
  const code = yield* child.exitCode
  return { out, code: Number(code) }
}).pipe(Effect.scoped)

describe("the accept lock by the clock", () => {
  it.live.layer(BunServices.layer)(
    "scripts/accept.test.ts's real runs keep their clock bounds: a land run near its budget, the lock free within 5 s of a mark, back within 2 s of a land run's death, taken at once from a killed deep run",
    () =>
      Effect.gen(function* () {
        const run = yield* timedRuns
        const lines = run.out.split("\n").map((line) => line.trim())
        expect({ code: run.code, failed: lines.filter((line) => line.startsWith("(fail)")), passed: lines.includes(`${TIMED_COUNT} pass`) }).toEqual({
          code: 0,
          failed: [],
          passed: true,
        })
      }),
    600_000,
  )
})

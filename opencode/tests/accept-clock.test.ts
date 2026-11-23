// @reads all
// @reads-reason subprocess reads at tests/accept-clock.test.ts: ChildProcess.make("bun", ["test", "./scripts/accept.test.ts", "-t", TIMED_RUNS], { env: { ACCEP
// accept: one at a time (it bounds by the clock how soon a deep run gives the accept lock up and takes it back).
// The wall-clock bounds of scripts/accept.test.ts's real runs of scripts/accept.ts. In the gate those runs
// judge what happened and in what order, never how fast: a loaded host stretches real time many times over,
// and a gate unit test does not judge it. Here, one at a time, ACCEPT_TIMED=1 makes the same runs judge their
// clock bounds too: a land run ends near its budget; the lock is free within 5 s of a land run's mark; a deep
// run takes the lock back within 2 s of the marking land run's death; a land run takes the lock of a killed deep
// run at once; a land run's swarm ends inside its box and grace.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { timedCounts, timedFilter } from "../scripts/accept-plan.ts"

/** The real runs of scripts/accept.test.ts that carry a clock bound (scripts/accept-plan.ts `TIMED_RUNS`). */
const TIMED_RUNS = timedFilter

/**
 * How many tests TIMED_RUNS names (`timedCount`), counted from scripts/accept.test.ts's text: a filter that matched fewer would judge
 * less. Derived, not kept by hand: a hand-kept 7 went stale when sim-load added a test to "a land run's swarm", and
 * only this deep file saw it. scripts/accept.test.ts checks the count against its own text in the gate.
 */
const timedCount = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return timedCounts(yield* fs.readFileString("scripts/accept.test.ts")).reduce((sum, each) => sum + each.tests, 0)
})

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
        const count = yield* timedCount
        const run = yield* timedRuns
        const lines = run.out.split("\n").map((line) => line.trim())
        expect({ code: run.code, failed: lines.filter((line) => line.startsWith("(fail)")), passed: lines.includes(`${count} pass`) }).toEqual({
          code: 0,
          failed: [],
          passed: true,
        })
      }),
    600_000,
  )
})

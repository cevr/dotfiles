// Wall time that bun's fake timers cannot move. Once a test holds
// `jest.useFakeTimers()` (sim-tui's TUI files hold them from their boot on),
// every timer the process arms is on the fake heap, AbortSignal.timeout and a
// setTimeout captured before the fakes alike, and fires on the test's virtual
// advances; every clock the process reads (Date.now, performance.now,
// process.hrtime, Bun.nanoseconds) is faked too. Another process keeps its own
// time: a `sleep` child ends after its wall time, and its exit reaches this
// process as I/O, which the fakes do not hold.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * Ends after `ms` of wall time, whatever timers the process holds: a `sleep` child's exit. Interrupted first, the
 * child is stopped with it.
 */
export const wallTime = (ms: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(
      ChildProcess.make("sleep", [(ms / 1_000).toFixed(3)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" }),
    )
    yield* child.exitCode
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie, Effect.asVoid)

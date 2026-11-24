// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// A wait on real I/O (`within`) is a deadline in wall time, not a count of passes. The boot waited 10 000 passes for
// the route plugin, and on a loaded host the plugin's real import outlasted them: escape-subagent failed "the route
// plugin (sim-tui/route) never loaded" inside accept-parity's child. A loader that takes real time loads within the
// deadline whatever the passes cost; one that never loads fails at the deadline, naming what never loaded and how long
// it waited.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as App from "./app.ts"
import { simulationTest } from "../sim/seed.ts"
import { simulationBudget } from "../sim/budget.ts"
import { wallTime } from "../sim/wall-clock.ts"

/** A loader that loads after `ms` of wall time (a child's sleep), forked; `loaded` turns true then. */
const slowLoader = (ms: number) =>
  Effect.gen(function* () {
    const loader = { loaded: false }
    const fiber = yield* Effect.forkChild(Effect.andThen(wallTime(ms), Effect.sync(() => (loader.loaded = true))))
    return { loader, fiber }
  })

describe("a wait on real I/O", () => {
  simulationTest(
    "a loader that takes 2 s of wall time loads: the wait is in time, not in passes",
    Effect.gen(function* () {
      const { loader, fiber } = yield* slowLoader(2_000)
      const exit = yield* Effect.exit(App.within([{ what: "the slow plugin never loaded", done: () => loader.loaded }], Effect.yieldNow, 20_000))
      yield* Fiber.interrupt(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(loader.loaded).toBe(true)
    }),
    simulationBudget(30_000),
  )

  simulationTest(
    "a loader that never loads fails at the deadline, naming what never loaded and how long it waited",
    Effect.gen(function* () {
      const armed = yield* Deferred.make<number>()
      const pass = yield* Deferred.make<void>()
      const expired = yield* Deferred.make<void>()
      const waiting = yield* Effect.forkChild(App.within(
        [{ what: "the route plugin (sim-tui/route) never loaded", done: () => false }],
        Deferred.complete(pass, Effect.void).pipe(Effect.andThen(Effect.yieldNow)),
        1_500,
        (ms) => Deferred.succeed(armed, ms).pipe(Effect.andThen(Deferred.await(expired))),
      ))
      expect(yield* Deferred.await(armed)).toBe(1_500)
      yield* Deferred.await(pass)
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* Deferred.complete(expired, Effect.void)
      const exit = yield* Fiber.await(waiting)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) && exit.cause)).toMatch(/the route plugin \(sim-tui\/route\) never loaded within 1500 ms of wall time \(\d+ passes\)/)
    }),
    simulationBudget(30_000),
  )

  simulationTest(
    "a wait whose loads are done runs no pass",
    Effect.gen(function* () {
      expect(yield* App.within([{ what: "nothing", done: () => true }], Effect.die("no pass runs"), 1_000)).toBe(0)
    }),
    simulationBudget(30_000),
  )
})

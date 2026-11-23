// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// A wait on real I/O (`within`) is a deadline in wall time, not a count of passes. The boot waited 10 000 passes for
// the route plugin, and on a loaded host the plugin's real import outlasted them: escape-subagent failed "the route
// plugin (sim-tui/route) never loaded" inside accept-parity's child. A loader that takes real time loads within the
// deadline whatever the passes cost; one that never loads fails at the deadline, naming what never loaded and how long
// it waited.
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import * as App from "./app.ts"
import * as Seed from "../sim/seed.ts"
import { wallTime } from "../sim/wall-clock.ts"

/** A loader that loads after `ms` of wall time (a child's sleep), forked; `loaded` turns true then. */
const slowLoader = (ms: number) =>
  Effect.gen(function* () {
    const loader = { loaded: false }
    const fiber = yield* Effect.forkChild(Effect.andThen(wallTime(ms), Effect.sync(() => (loader.loaded = true))))
    return { loader, fiber }
  })

/** `within` on one loader, stepping a turn at a time, and the wall time it took. */
const wait = (what: string, done: () => boolean, deadlineMs: number) =>
  Effect.gen(function* () {
    const began = yield* App.wallNow
    const exit = yield* Effect.exit(App.within([{ what, done }], Effect.yieldNow, deadlineMs))
    return { exit, took: (yield* App.wallNow) - began }
  })

describe("a wait on real I/O", () => {
  Seed.effect(
    "a loader that takes 2 s of wall time loads: the wait is in time, not in passes",
    Effect.gen(function* () {
      const { loader, fiber } = yield* slowLoader(2_000)
      const { exit, took } = yield* wait("the slow plugin never loaded", () => loader.loaded, 20_000)
      yield* Fiber.interrupt(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(loader.loaded).toBe(true)
      expect(took).toBeGreaterThanOrEqual(1_900)
    }),
    30_000,
  )

  Seed.effect(
    "a loader that never loads fails at the deadline, naming what never loaded and how long it waited",
    Effect.gen(function* () {
      const { exit, took } = yield* wait("the route plugin (sim-tui/route) never loaded", () => false, 1_500)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) && exit.cause)).toMatch(/the route plugin \(sim-tui\/route\) never loaded within 1500 ms of wall time \(\d+ passes\)/)
      expect(took).toBeGreaterThanOrEqual(1_400)
      expect(took).toBeLessThan(1_500 + 5_000)
    }),
    30_000,
  )

  Seed.effect(
    "a wait whose loads are done runs no pass",
    Effect.gen(function* () {
      expect(yield* App.within([{ what: "nothing", done: () => true }], Effect.die("no pass runs"), 1_000)).toBe(0)
    }),
    30_000,
  )
})

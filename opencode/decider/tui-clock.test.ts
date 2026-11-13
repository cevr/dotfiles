// The TUI clock: the system clock until a harness installs one; every read and
// timer goes to the clock in force at that moment; the install's undo puts the
// one before it back. Its registry is process-wide (Symbol.for), so a plugin
// that loaded its own copy of this module reads the same clock.
import { Array as Arr, Clock, Effect, Option } from "effect"
import { describe, expect } from "bun:test"
import { effectTest } from "../sim-tui/effect-test.ts"
import * as TuiClock from "./tui-clock.ts"

/** A test here moves no real time. */
const TIMEOUT_MS = 5_000

interface Timer {
  at: number
  readonly every: Option.Option<number>
  readonly run: () => void
}

/** A manual clock: time moves only by `advance`, which runs the timers it passes, in time order. */
const manual = (start: number) => {
  const state = { now: start, next: 0 }
  const timers = new Map<number, Timer>()
  const add = (at: number, run: () => void, every: Option.Option<number>) => {
    const id = state.next++
    timers.set(id, { at, run, every })
    return () => {
      timers.delete(id)
    }
  }
  const clock: TuiClock.Clock = {
    now: () => state.now,
    once: (ms, run) => add(state.now + ms, run, Option.none()),
    every: (ms, run) => add(state.now + ms, run, Option.some(ms)),
  }
  /** The timer due first by `end`, if one is. */
  const due = (end: number) =>
    Arr.head(
      [...timers.entries()].filter(([, timer]) => timer.at <= end).toSorted(([, a], [, b]) => a.at - b.at),
    )
  const advance = (ms: number) => {
    const end = state.now + ms
    for (let next = due(end); Option.isSome(next); next = due(end)) {
      const [id, timer] = next.value
      state.now = timer.at
      Option.match(timer.every, {
        onNone: () => timers.delete(id),
        onSome: (every) => (timer.at += every),
      })
      timer.run()
    }
    state.now = end
  }
  return { clock, advance }
}

// decider resolves the fork's Effect, whose types are not effect-bun-test's: its tests register as sim-tui's do.
const effect = <A, E>(name: string, body: Effect.Effect<A, E>) => effectTest(name, body, TIMEOUT_MS)

/** `use` with `clock` installed, and the clock before it put back after, however `use` ends. */
const installed = <A, E>(clock: TuiClock.Clock, use: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => TuiClock.install(clock)),
    () => use,
    (undo) => Effect.sync(undo),
  )

describe("the TUI clock", () => {
  effect("without an install it is the system clock",
    Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis
      const read = TuiClock.now()
      expect(read).toBeGreaterThanOrEqual(before)
      expect(read).toBeLessThanOrEqual(yield* Clock.currentTimeMillis)
      expect(TuiClock.current()).toBe(TuiClock.system)
    }),
  )

  effect("an installed clock holds every read and timer until its undo",
    Effect.gen(function* () {
      const { clock, advance } = manual(1_000)
      yield* installed(
        clock,
        Effect.sync(() => {
          expect(TuiClock.now()).toBe(1_000)
          const fired: Array<string> = []
          TuiClock.once(500, () => fired.push(`after ${TuiClock.now()}`))
          const stop = TuiClock.every(200, () => fired.push(`every ${TuiClock.now()}`))
          const cancelled = TuiClock.once(300, () => fired.push("cancelled"))
          cancelled()
          advance(450)
          stop()
          advance(1_000)
          expect(fired).toEqual(["every 1200", "every 1400", "after 1500"])
          expect(TuiClock.now()).toBe(2_450)
        }),
      )
      expect(TuiClock.current()).toBe(TuiClock.system)
    }),
  )

  effect("the clock is process-wide: the registry under its global symbol is what every copy reads",
    Effect.gen(function* () {
      const { clock } = manual(42)
      yield* installed(
        clock,
        Effect.sync(() => {
          const registry: { [key: symbol]: TuiClock.Clock } = globalThis
          expect(registry[Symbol.for("dotfiles.tui-clock")]).toBe(clock)
        }),
      )
    }),
  )
})

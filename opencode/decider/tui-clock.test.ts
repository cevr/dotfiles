// The TUI clock: the system clock until a harness installs one; every read and
// timer goes to the clock in force at that moment; the install's undo puts the
// one before it back. Its registry is process-wide (Symbol.for), so a plugin
// that loaded its own copy of this module reads the same clock.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import * as TuiClock from "./tui-clock.ts"

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

/** `clock` installed until the scope that holds the result ends, however it ends (a `using` declaration). */
const installed = (clock: TuiClock.Clock) => ({ [Symbol.dispose]: TuiClock.install(clock) })

describe("the TUI clock", () => {
  test("without an install it is the system clock", () => {
    const before = TuiClock.system.now()
    const read = TuiClock.now()
    expect(read).toBeGreaterThanOrEqual(before)
    expect(read).toBeLessThanOrEqual(TuiClock.system.now())
    expect(TuiClock.current()).toBe(TuiClock.system)
  })

  test("an installed clock holds every read and timer until its undo", () => {
    const { clock, advance } = manual(1_000)
    {
      using _held = installed(clock)
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
    }
    expect(TuiClock.current()).toBe(TuiClock.system)
  })

  test("the clock is process-wide: the registry under its global symbol is what every copy reads", () => {
    const { clock } = manual(42)
    using _held = installed(clock)
    const registry: { [key: symbol]: TuiClock.Clock } = globalThis
    expect(registry[Symbol.for("dotfiles.tui-clock")]).toBe(clock)
  })
})

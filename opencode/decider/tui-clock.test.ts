// The TUI clock: the system clock until a harness installs one; every read and
// timer goes to the clock in force at that moment; the install's undo puts the
// one before it back. Its registry is process-wide (Symbol.for), so a plugin
// that loaded its own copy of this module reads the same clock.
import { expect, test } from "bun:test"
import * as TuiClock from "./tui-clock.ts"

/** A manual clock: time moves only by `advance`, which runs the timers it passes, in time order. */
const manual = (start: number) => {
  const state = { now: start, next: 0 }
  const timers = new Map<number, { at: number; every?: number; run: () => void }>()
  const add = (at: number, run: () => void, every?: number) => {
    const id = state.next++
    timers.set(id, { at, run, every })
    return () => {
      timers.delete(id)
    }
  }
  const clock: TuiClock.Clock = {
    now: () => state.now,
    once: (ms, run) => add(state.now + ms, run),
    every: (ms, run) => add(state.now + ms, run, ms),
  }
  const advance = (ms: number) => {
    const end = state.now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).toSorted(([, a], [, b]) => a.at - b.at)[0]
      if (due === undefined) break
      const [id, timer] = due
      state.now = timer.at
      if (timer.every === undefined) timers.delete(id)
      else timer.at += timer.every
      timer.run()
    }
    state.now = end
  }
  return { clock, advance }
}

test("without an install it is the system clock", () => {
  const before = Date.now()
  const read = TuiClock.now()
  expect(read).toBeGreaterThanOrEqual(before)
  expect(read).toBeLessThanOrEqual(Date.now())
  expect(TuiClock.current()).toBe(TuiClock.system)
})

test("an installed clock holds every read and timer until its undo", () => {
  const { clock, advance } = manual(1_000)
  const undo = TuiClock.install(clock)
  try {
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
  } finally {
    undo()
  }
  expect(TuiClock.current()).toBe(TuiClock.system)
})

test("the clock is process-wide: the registry under its global symbol is what every copy reads", () => {
  const { clock } = manual(42)
  const undo = TuiClock.install(clock)
  try {
    const registry: { [key: symbol]: unknown } = globalThis
    expect(registry[Symbol.for("dotfiles.tui-clock")]).toBe(clock)
  } finally {
    undo()
  }
})

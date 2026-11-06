// The shared clock: a running row ticks with it, a settled one never
// recomputes on another row's tick. Bun's tests resolve solid-js to its server
// build, which never re-runs a computation, so this file takes the reactive
// build OpenCode loads.
import { expect, mock, test } from "bun:test"
import { TICK_MS } from "../clock.ts"

// The build's file carries no types of its own; the import below takes solid-js's.
const REACTIVE = "solid-js/dist/solid.js"
mock.module("solid-js", () => import(REACTIVE))
const { createMemo, createRoot, createSignal } = await import("solid-js")
const { useNow } = await import("./clock.ts")

test("only a reader whose row runs recomputes on the clock's ticks", async () => {
  const [settled, setSettled] = createSignal(false)
  const runs = { running: 0, settled: 0 }
  const dispose = createRoot((dispose) => {
    const running = useNow(() => true)
    const idle = useNow(settled)
    createMemo(() => (running(), runs.running++))
    createMemo(() => (idle(), runs.settled++))
    return dispose
  })
  await Bun.sleep(TICK_MS * 3 + 50)
  expect(runs.running).toBeGreaterThanOrEqual(3)
  expect(runs.settled).toBe(1)
  // Once its row runs again, it ticks too.
  setSettled(true)
  const from = runs.settled
  await Bun.sleep(TICK_MS * 2 + 50)
  expect(runs.settled - from).toBeGreaterThanOrEqual(2)
  dispose()
})

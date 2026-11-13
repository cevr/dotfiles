// accept: deep (57.5 s alone on a quiet host: 1-minute load 152.2–145.3 on 12 cores; it drives a TUI from source to its session picker, then restarts the service and holds it booting for 8 s)
// A pane at home selects a cached session while the service boots, and submits.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, selectWhileBooting, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-select-cached-")
  test(
    "selecting a cached session from home during service boot and submitting waits without an error toast",
    reconnectTest(kept, (fixture) => selectWhileBooting(fixture, "cached")),
    TIMEOUT_MS,
  )
})

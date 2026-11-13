// accept: deep (49.7 s alone on a quiet host: 1-minute load 145.3–142.5 on 12 cores; it drives a TUI from source to its session picker, then restarts the service and holds it booting for 8 s)
// A pane at home selects a down session while the service boots, and submits.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, selectWhileBooting, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-select-down-")
  test(
    "selecting a down session from home during service boot and submitting waits without an error toast",
    reconnectTest(kept, (fixture) => selectWhileBooting(fixture, "down")),
    TIMEOUT_MS,
  )
})

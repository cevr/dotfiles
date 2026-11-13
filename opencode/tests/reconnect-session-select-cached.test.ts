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

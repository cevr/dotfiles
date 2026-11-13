// A pane at home selects a cached session while the service boots, and submits.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, selectWhileBooting, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-select-cached.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-select-cached-")
  test(
    "selecting a cached session from home during service boot and submitting waits without an error toast",
    reconnectTest(kept, (fixture) => selectWhileBooting(fixture, "cached")),
    TIMEOUT_MS,
  )
})

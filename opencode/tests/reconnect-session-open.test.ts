// accept: deep (47.2 s alone on a quiet host: 1-minute load 89.8–140.5 on 12 cores; it starts a service from source and opens five TUIs from source on it while it is down or booting)
// A TUI opened while the service is down or booting waits for it, says so, and opens its session.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { openWhileDown, reconnectTest, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-open-")
  test("a TUI opened while the service is down or booting waits for it, says so, and opens its session", reconnectTest(kept, openWhileDown), TIMEOUT_MS)
})

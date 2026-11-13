// A TUI opened while the service is down or booting waits for it, says so, and opens its session.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { openWhileDown, reconnectTest, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-open-")
  test("a TUI opened while the service is down or booting waits for it, says so, and opens its session", reconnectTest(kept, openWhileDown), TIMEOUT_MS)
})

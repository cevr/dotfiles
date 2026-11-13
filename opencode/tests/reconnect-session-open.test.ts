// A TUI opened while the service is down or booting waits for it, says so, and opens its session.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { FORK, SUITE, TIMEOUT_MS, openWhileDown, reconnectTest, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-open.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-open-")
  test("a TUI opened while the service is down or booting waits for it, says so, and opens its session", reconnectTest(kept, openWhileDown), TIMEOUT_MS)
})

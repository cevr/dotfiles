// A TUI on a worker whose Rift is gone keeps its session across a restart.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, riftOf, skipNotice, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-gone.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-gone-")
  test(
    "after `service restart` the TUI keeps a worker whose Rift is gone without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "gone", transcript(fixture, "Reconnect worker", "worker-transcript-marker", riftOf(fixture)), "worker-transcript-marker", { gone: riftOf(fixture) }),
    ),
    TIMEOUT_MS,
  )
})

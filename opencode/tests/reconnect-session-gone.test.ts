// A TUI on a worker whose Rift is gone keeps its session across a restart.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, restart, riftOf, SUITE, test, TIMEOUT_MS, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-gone-")
  test(
    "after `service restart` the TUI keeps a worker whose Rift is gone without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "gone", transcript(fixture, "Reconnect worker", "worker-transcript-marker", riftOf(fixture)), "worker-transcript-marker", { gone: riftOf(fixture) }),
    ),
    TIMEOUT_MS,
  )
})

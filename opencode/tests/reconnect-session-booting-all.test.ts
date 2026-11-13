// The owner's panes: a draft survives a restart whose service refuses everything while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-booting-all-")
  test(
    "after `service restart` the TUI keeps a draft while the service refuses everything without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting-all", transcript(fixture, "Reconnect booting all", "booting-all-transcript-marker"), "booting-all-transcript-marker", { bootingAll: true, draft: true }),
    ),
    TIMEOUT_MS,
  )
})

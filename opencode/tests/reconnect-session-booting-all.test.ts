// accept: deep (59.8 s alone on a quiet host: 1-minute load 124.3–120.6 on 12 cores; it starts a service from source and restarts it under a TUI from source, then holds an 8 s booting window)
// The owner's panes: a draft survives a restart whose service refuses everything while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS, transcript } from "./reconnect/fixture.ts"
import { forkRuns, keptScratch } from "./scratch.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-booting-all-")
  test(
    "after `service restart` the TUI keeps a draft while the service refuses everything without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting-all", transcript(fixture, "Reconnect booting all", "booting-all-transcript-marker"), "booting-all-transcript-marker", { bootingAll: true, draft: true }),
    ),
    TIMEOUT_MS,
  )
})

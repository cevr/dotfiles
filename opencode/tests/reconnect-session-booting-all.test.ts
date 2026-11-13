// The owner's panes: a draft survives a restart whose service refuses everything while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, skipNotice, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-booting-all.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-booting-all-")
  test(
    "after `service restart` the TUI keeps a draft while the service refuses everything without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting-all", transcript(fixture, "Reconnect booting all", "booting-all-transcript-marker"), "booting-all-transcript-marker", { bootingAll: true, draft: true }),
    ),
    TIMEOUT_MS,
  )
})

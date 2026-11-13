// accept: deep (55.6 s alone on a quiet host: 1-minute load 42.3–51.0 on 12 cores; it starts a service from source and restarts it under a TUI from source, then holds an 8 s booting window)
// The owner's panes: a draft in a TUI opened while the service boots survives a restart.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-draft-")
  test(
    "after `service restart` the TUI keeps a draft in a TUI opened while the service boots without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "draft", transcript(fixture, "Reconnect draft", "draft-transcript-marker"), "draft-transcript-marker", { draft: true, starting: true }),
    ),
    TIMEOUT_MS,
  )
})

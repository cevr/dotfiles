// The owner's panes: a draft in a TUI opened while the service boots survives a restart.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, skipNotice, transcript } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-draft.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-draft-")
  test(
    "after `service restart` the TUI keeps a draft in a TUI opened while the service boots without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "draft", transcript(fixture, "Reconnect draft", "draft-transcript-marker"), "draft-transcript-marker", { draft: true, starting: true }),
    ),
    TIMEOUT_MS,
  )
})

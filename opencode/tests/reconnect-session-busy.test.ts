// A TUI on a root whose turn the restart cuts keeps it.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-busy.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-busy-")
  test(
    "after `service restart` the TUI keeps a root whose turn the restart cuts without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "busy", Effect.succeed(fixture.parent), "parent-transcript-marker", { busy: true }),
    ),
    TIMEOUT_MS,
  )
})

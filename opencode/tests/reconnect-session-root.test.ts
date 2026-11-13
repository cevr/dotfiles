// A TUI on a root session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-root.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-root-")
  test(
    "after `service restart` the TUI keeps a root session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "root", Effect.succeed(fixture.parent), "parent-transcript-marker"),
    ),
    TIMEOUT_MS,
  )
})

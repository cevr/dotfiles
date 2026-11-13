// A TUI on a subagent session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import { FORK, SUITE, TIMEOUT_MS, reconnectTest, restart, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session-child.test.ts")

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-child-")
  test(
    "after `service restart` the TUI keeps a subagent session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "child", Effect.succeed(fixture.child), "child-transcript-marker"),
    ),
    TIMEOUT_MS,
  )
})

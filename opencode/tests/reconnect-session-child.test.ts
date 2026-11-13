// A TUI on a subagent session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-child-")
  test(
    "after `service restart` the TUI keeps a subagent session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "child", Effect.succeed(fixture.child), "child-transcript-marker"),
    ),
    TIMEOUT_MS,
  )
})

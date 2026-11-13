// A TUI on a root whose turn the restart cuts keeps it.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-busy-")
  test(
    "after `service restart` the TUI keeps a root whose turn the restart cuts without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "busy", Effect.succeed(fixture.parent), "parent-transcript-marker", { busy: true }),
    ),
    TIMEOUT_MS,
  )
})

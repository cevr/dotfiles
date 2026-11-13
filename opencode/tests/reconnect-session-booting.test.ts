// A TUI keeps a session the restarted service refuses while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-booting-")
  test(
    "after `service restart` the TUI keeps a session the booting service refuses without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting", Effect.succeed(fixture.parent), "parent-transcript-marker", { booting: true }),
    ),
    TIMEOUT_MS,
  )
})

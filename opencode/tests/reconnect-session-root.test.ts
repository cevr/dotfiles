// accept: deep (41.7 s alone on a quiet host: 1-minute load 140.5–152.2 on 12 cores; it starts a service from source and restarts it under a TUI from source)
// A TUI on a root session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-root-")
  test(
    "after `service restart` the TUI keeps a root session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "root", Effect.succeed(fixture.parent), "parent-transcript-marker"),
    ),
    TIMEOUT_MS,
  )
})

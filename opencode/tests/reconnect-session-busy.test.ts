// accept: deep (48.1 s alone on a quiet host: 1-minute load 91.3–58.9 on 12 cores; it starts a service from source and restarts it under a TUI from source)
// A TUI on a root whose turn the restart cuts keeps it.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { forkRuns, keptScratch } from "./scratch.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-busy-")
  test(
    "after `service restart` the TUI keeps a root whose turn the restart cuts without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "busy", Effect.succeed(fixture.parent), "parent-transcript-marker", { busy: true }),
    ),
    TIMEOUT_MS,
  )
})

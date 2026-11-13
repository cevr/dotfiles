// accept: deep (59.4 s alone on a quiet host: 1-minute load 120.6–91.3 on 12 cores; it starts a service from source and restarts it under a TUI from source, then holds an 8 s booting window)
// A TUI keeps a session the restarted service refuses while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { reconnectTest, restart, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { forkRuns, keptScratch } from "./scratch.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-booting-")
  test(
    "after `service restart` the TUI keeps a session the booting service refuses without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting", Effect.succeed(fixture.parent), "parent-transcript-marker", { booting: true }),
    ),
    TIMEOUT_MS,
  )
})

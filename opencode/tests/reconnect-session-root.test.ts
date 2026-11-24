// accept: deep (41.7 s alone on a quiet host: 1-minute load 140.5–152.2 on 12 cores; it starts a service from source and restarts it under a TUI from source)
// A TUI on a root session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { it } from "effect-bun-test"
import { reconnectTest, restart, SUITE, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { Platform } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-root-")
  it.scopedLive.layer(Platform)(
    "after `service restart` the TUI keeps a root session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "root", Effect.succeed(fixture.parent), "parent-transcript-marker"),
    ),
    hangGuard("fork-session"),
  )
})

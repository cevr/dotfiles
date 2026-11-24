// accept: deep (41.5 s alone on a quiet host: 1-minute load 58.9–42.3 on 12 cores; it starts a service from source and restarts it under a TUI from source)
// A TUI on a subagent session keeps it across `service restart`.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { it } from "effect-bun-test"
import { reconnectTest, restart, SUITE, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { Platform } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-child-")
  it.scopedLive.layer(Platform)(
    "after `service restart` the TUI keeps a subagent session without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "child", Effect.succeed(fixture.child), "child-transcript-marker"),
    ),
    hangGuard("fork-session"),
  )
})

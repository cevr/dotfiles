// @reads cmd/*
// accept: deep (59.4 s alone on a quiet host: 1-minute load 120.6–91.3 on 12 cores; it starts a service from source and restarts it under a TUI from source, then holds an 8 s booting window)
// A TUI keeps a session the restarted service refuses while it boots.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { Effect } from "effect"
import { it } from "effect-bun-test"
import { reconnectTest, restart, SUITE, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { Platform } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-booting-")
  it.scopedLive.layer(Platform)(
    "after `service restart` the TUI keeps a session the booting service refuses without an error toast in any frame",
    reconnectTest(kept, (fixture) =>
      restart(fixture, "booting", Effect.succeed(fixture.parent), "parent-transcript-marker", { booting: true }),
    ),
    hangGuard("fork-session"),
  )
})

// @reads cmd/*
// accept: deep (47.2 s alone on a quiet host: 1-minute load 89.8–140.5 on 12 cores; it starts a service from source and opens five TUIs from source on it while it is down or booting)
// A TUI opened while the service is down or booting waits for it, says so, and opens its session.
// The shared world and the cases' bodies: tests/reconnect/fixture.ts.
import { describe } from "bun:test"
import { it } from "effect-bun-test"
import { openWhileDown, reconnectTest, SUITE, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { Platform } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

describe.skipIf(!forkRuns)(SUITE, () => {
  const kept = keptScratch(forkRuns, "rs-open-")
  it.scopedLive.layer(Platform)("a TUI opened while the service is down or booting waits for it, says so, and opens its session", reconnectTest(kept, openWhileDown), hangGuard("fork-session"))
})

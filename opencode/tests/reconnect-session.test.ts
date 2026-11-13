// accept: deep (63.8 s alone on a quiet host: 1-minute load 136.4–65.0 on 12 cores; it starts a service from source, stops it and restarts it under a TUI from source that finds it by its registration)
// A TUI attached to the background service keeps its session across a service restart: the
// cases are split by group into reconnect-session-*.test.ts, each with a service of its own, so
// they run side by side (tests/reconnect/fixture.ts says what each covers). This file holds the
// frame guard they share and the managed case: a TUI opened on a stopped or restarting
// background service opens its session.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect } from "effect-bun-test"
import { errorToast, openManaged, reconnectTest, SUITE, test, TIMEOUT_MS } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

test("the frame guard recognizes a transient error toast, not transcript text", () =>
  Effect.sync(() => {
    const toast = ["", `${" ".repeat(60)}┃  Failed to fetch             x ┃`]
    expect(Option.getOrElse(errorToast(toast), () => "")).toContain("Failed to fetch")
    expect(Option.isNone(errorToast(["Failed to fetch is text in the session"]))).toBe(true)
  }),
)

describe(SUITE, () => {
  const kept = keptScratch(true, "rs-managed-")
  test("a TUI opened on the background service while it is stopped or restarting opens its session", reconnectTest(kept, openManaged), TIMEOUT_MS)
})

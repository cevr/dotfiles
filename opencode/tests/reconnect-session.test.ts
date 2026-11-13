// A TUI attached to the background service keeps its session across a service restart: the
// cases are split by group into reconnect-session-*.test.ts, each with a service of its own, so
// they run side by side (tests/reconnect/fixture.ts says what each covers). This file holds the
// frame guard they share and the managed case: a TUI opened on a stopped or restarting
// background service opens its session.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { FORK, SUITE, TIMEOUT_MS, errorToast, openManaged, reconnectTest, skipNotice } from "./reconnect/fixture.ts"
import { keptScratch } from "./scratch.ts"

skipNotice("tests/reconnect-session.test.ts")

test("the frame guard recognizes a transient error toast, not transcript text", () => {
  const toast = ["", `${" ".repeat(60)}┃  Failed to fetch             x ┃`]
  expect(Option.getOrElse(errorToast(toast), () => "")).toContain("Failed to fetch")
  expect(Option.isNone(errorToast(["Failed to fetch is text in the session"]))).toBe(true)
})

describe.skipIf(FORK === "")(SUITE, () => {
  const kept = keptScratch(FORK !== "", "rs-managed-")
  test("a TUI opened on the background service while it is stopped or restarting opens its session", reconnectTest(kept, openManaged), TIMEOUT_MS)
})

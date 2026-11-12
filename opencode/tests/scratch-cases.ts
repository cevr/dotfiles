import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { keptScratch } from "./scratch.ts"

/** A body that never returns, so its test runs out of time. */
const hang = () => Effect.runPromise(Effect.never)

/** How long a hanging case waits before Bun gives up on it. */
const HANG_MS = 50

describe("passing", () => {
  const kept = keptScratch(true, "kept-passing-")
  test("first", kept.test(() => expect(kept.dir("frames-")).toContain(kept.path)))
  test("second", kept.test(() => expect(kept.path).not.toBe("")))
})

describe("failing", () => {
  const kept = keptScratch(true, "kept-failing-")
  test("first", kept.test(() => expect("kept").toBe("removed")))
  test("second", kept.test(() => expect(kept.path).not.toBe("")))
})

describe("setup-failing", () => {
  const kept = keptScratch(true, "kept-setup-failing-")
  test("setup", kept.setup(() => expect("set up").toBe("broken")))
})

describe("timing-out", () => {
  const kept = keptScratch(true, "kept-timing-out-")
  test("hangs", kept.test(hang), HANG_MS)
  test("after", kept.test(() => expect(kept.path).not.toBe("")))
})

describe("setup-timing-out", () => {
  const kept = keptScratch(true, "kept-setup-timing-out-")
  test("setup", kept.setup(hang), HANG_MS)
})

describe("closing", () => {
  const kept = keptScratch(true, "kept-closes-", true)
  test("first", kept.test(() => expect(kept.path).not.toBe("")))
  test("closes", () => kept.done())
})

describe("closing-after-timeout", () => {
  const kept = keptScratch(true, "kept-closing-after-timeout-", true)
  test("hangs", kept.test(hang), HANG_MS)
  test("closes", () => kept.done())
})

describe.skipIf(true)("skipped", () => {
  const kept = keptScratch(false, "kept-skipped-")
  test("never runs", kept.test(() => expect(kept.path).toBe("")))
})

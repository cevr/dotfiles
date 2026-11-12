import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { keptScratch } from "./scratch.ts"

/** A body that never returns, so its test runs out of time. */
const hang = () => Effect.runPromise(Effect.never)

/** How long a hanging case waits before Bun gives up on it. */
const HANG_MS = 50

/** How long a setup that returns in time may take. */
const SETUP_MS = 5_000

/** A body that returns, but only well after HANG_MS, and before a waiting test ends. */
const late = () => Effect.runPromise(Effect.sleep(`${HANG_MS * 3} millis`))

/** A test that outlasts `late`, so the suite ends after it returned. */
const wait = () => Effect.runPromise(Effect.sleep(`${HANG_MS * 6} millis`))

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
  test("setup", ...kept.setup(() => expect("set up").toBe("broken"), SETUP_MS))
})

describe("setup-passing", () => {
  const kept = keptScratch(true, "kept-setup-passing-")
  test("setup", ...kept.setup(() => expect(kept.dir("frames-")).toContain(kept.path), SETUP_MS))
  test("first", kept.test(() => expect(kept.path).not.toBe("")))
})

describe("timing-out", () => {
  const kept = keptScratch(true, "kept-timing-out-")
  test("hangs", kept.test(hang), HANG_MS)
  test("after", kept.test(() => expect(kept.path).not.toBe("")))
})

describe("setup-timing-out", () => {
  const kept = keptScratch(true, "kept-setup-timing-out-")
  test("setup", ...kept.setup(hang, HANG_MS))
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

describe("late-writer", () => {
  const kept = keptScratch(true, "kept-late-writer-")
  const writeLate = () => Effect.runPromise(Effect.sleep(`${HANG_MS * 3} millis`).pipe(Effect.andThen(Effect.sync(() => kept.dir("scenario-"))), Effect.asVoid))
  test("hangs then writes", kept.test(writeLate), HANG_MS)
})

describe("closing-after-late-setup", () => {
  const kept = keptScratch(true, "kept-closing-after-late-setup-", true)
  test("setup", ...kept.setup(late, HANG_MS))
  test("waits", wait, HANG_MS * 12)
  test("closes", () => kept.done())
})

describe.skipIf(true)("skipped", () => {
  const kept = keptScratch(false, "kept-skipped-")
  test("never runs", kept.test(() => expect(kept.path).toBe("")))
})

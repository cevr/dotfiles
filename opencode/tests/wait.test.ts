// accept: one at a time (it measures waitUntil against seconds of real delay).
// tests/wait.ts: a test's wait for background work is bounded by the event it waits for, not by a
// second or two of wall clock that a loaded machine outruns (batch av: the scratch guard's child run
// went red at a load of 316, the likeliest cause cmd/pool's 1 s waitFor).
import { describe, expect, test } from "bun:test"
import { eventuallyPasses, waitUntil } from "./wait.ts"

/** A flag that turns true after `ms` of real time, as background work that is slow under load. */
const lateFlag = (ms: number) => {
  const flag = { set: false }
  setTimeout(() => {
    flag.set = true
  }, ms)
  return flag
}

/** How long the late condition takes: past the 1 s, 2 s and 3 s bounds the old helpers held. */
const LATE_MS = 3_500

/** How long a case may run: the late condition, with room for a loaded machine. */
const CASE_MS = 60_000

describe("a test's wait for background work", () => {
  test(
    "waitUntil passes once a condition comes true after seconds of real delay",
    async () => {
      const flag = lateFlag(LATE_MS)
      const started = Date.now()
      await waitUntil("the late flag", () => flag.set)
      expect(Date.now() - started).toBeGreaterThanOrEqual(LATE_MS - 50)
    },
    CASE_MS,
  )

  test(
    "waitUntil fails with the condition's name when it never comes true",
    async () => {
      await expect(waitUntil("the flag nobody sets", () => false, 200)).rejects.toThrow("waited 200 ms in vain for the flag nobody sets")
    },
    CASE_MS,
  )

  test(
    "eventuallyPasses passes once its expectations hold after seconds of real delay, and fails with their own message when they never do",
    async () => {
      const flag = lateFlag(LATE_MS)
      await eventuallyPasses(() => expect(flag.set).toBe(true))
      await expect(eventuallyPasses(() => expect("asked", "the never-asked question").toBe("answered"), 200)).rejects.toThrow("the never-asked question")
    },
    CASE_MS,
  )
})

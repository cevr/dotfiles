// tests/wait.ts: a test's wait for background work is bounded by the event it waits for, not by a
// second or two of wall clock that a loaded machine outruns (batch av: the scratch guard's child run
// went red at a load of 316, the likeliest cause cmd/pool's 1 s waitFor).
import { describe, expect, test } from "bun:test"
import { eventuallyPasses, waitUntil } from "./wait.ts"
import { hangGuard } from "./hang-guard.ts"

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


describe("a test's wait for background work", () => {
  test(
    "waitUntil passes once a condition comes true after seconds of real delay",
    async () => {
      const flag = lateFlag(LATE_MS)
      await waitUntil("the late flag", () => flag.set)
      expect(flag.set).toBe(true)
    },
    hangGuard("process-fixture"),
  )

  test(
    "waitUntil fails with the condition's name when it never comes true",
    async () => {
      await expect(waitUntil("the flag nobody sets", () => false, 200)).rejects.toThrow("waited 200 ms in vain for the flag nobody sets")
    },
    hangGuard("process-fixture"),
  )

  test(
    "eventuallyPasses passes once its expectations hold after seconds of real delay, and fails with their own message when they never do",
    async () => {
      const flag = lateFlag(LATE_MS)
      await eventuallyPasses(() => expect(flag.set).toBe(true))
      await expect(eventuallyPasses(() => expect("asked", "the never-asked question").toBe("answered"), 200)).rejects.toThrow("the never-asked question")
    },
    hangGuard("process-fixture"),
  )
})

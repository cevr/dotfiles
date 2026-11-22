// One read of a peer is bounded: a peer that never answers is down after the timeout, one that cannot be reached is
// down at once, and neither fails the pull.
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { Reading } from "../peers.ts"
import { readOne } from "./peers.ts"

describe("one read of a peer", () => {
  const target = { name: "workbox", base: "http://127.0.0.1:9" }

  test("a peer that never answers is down after the timeout", async () => {
    expect(await Effect.runPromise(readOne(() => Effect.never, target, Duration.millis(20)))).toEqual(Reading.Down({ reason: "no answer in 0.02 s" }))
  })

  test("a peer that cannot be reached is down at once", async () => {
    expect(await Effect.runPromise(readOne(() => Effect.fail("ECONNREFUSED"), target))).toEqual(Reading.Down({ reason: "unreachable" }))
  })
})

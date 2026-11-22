// One read of a peer is bounded: a peer that never answers is down after the timeout, one that cannot be reached is
// down at once, and neither fails the pull.
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { Reading } from "../peers.ts"
import { get } from "../process/peers.ts"
import { readOne } from "./peers.ts"

describe("one read of a peer", () => {
  const target = { name: "workbox", base: "http://127.0.0.1:9" }

  test("a peer that never answers is down after the timeout", async () => {
    expect(await Effect.runPromise(readOne(() => Effect.never, target, Duration.millis(20)))).toEqual(Reading.Down({ reason: "no answer in 0.02 s" }))
  })

  test("a peer that cannot be reached is down at once", async () => {
    expect(await Effect.runPromise(readOne(() => Effect.fail("ECONNREFUSED"), target))).toEqual(Reading.Down({ reason: "unreachable" }))
  })

  test("a read sends no credential: no token, no cookie, no authorization, whatever this host holds", async () => {
    const seen: Array<ReadonlyArray<string>> = []
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (seen.push([...request.headers.keys()]), new Response("{}")) })
    await Effect.runPromise(readOne(get, { name: "workbox", base: `http://127.0.0.1:${server.port}` }))
    expect(seen.length).toBe(1)
    expect(seen.flat().filter((name) => ["x-digest-token", "cookie", "authorization"].includes(name.toLowerCase()))).toEqual([])
  })
})

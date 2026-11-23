// One read of a peer is bounded: a peer that never answers is down after the timeout, one that cannot be reached is
// down at once, and neither fails the pull.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { describe } from "bun:test"
import { Duration, Effect, Ref } from "effect"
import { expect, it } from "effect-bun-test"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Reading } from "../peers.ts"
import { get } from "../process/peers.ts"
import { readOne } from "./peers.ts"

describe("one read of a peer", () => {
  const target = { name: "workbox", base: "http://127.0.0.1:9" }

  it.live("a peer that never answers is down after the timeout", () =>
    Effect.map(readOne(() => Effect.never, target, Duration.millis(20)), (reading) => expect(reading).toEqual(Reading.Down({ reason: "no answer in 0.02 s" }))),
  )

  it.live("a peer that cannot be reached is down at once", () =>
    Effect.map(readOne(() => Effect.fail("ECONNREFUSED"), target), (reading) => expect(reading).toEqual(Reading.Down({ reason: "unreachable" }))),
  )

  it.scopedLive("a read sends no credential: no token, no cookie, no authorization, whatever this host holds", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })
      yield* server.serve(
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => Effect.as(Ref.update(seen, (all) => [...all, Object.keys(request.headers)]), HttpServerResponse.text("{}"))),
      )
      yield* readOne(get, { name: "workbox", base: HttpServer.formatAddress(server.address) })
      const headers = yield* Ref.get(seen)
      expect(headers.length).toBe(1)
      expect(headers.flat().filter((name) => ["x-digest-token", "cookie", "authorization"].includes(name.toLowerCase()))).toEqual([])
    }),
  )
})

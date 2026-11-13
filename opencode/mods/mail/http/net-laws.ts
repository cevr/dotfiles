// What every network between paired hosts (service.ts `Net`) owes, as a shared
// suite: the real one on loopback (peers.ts `liveNet`, net.test.ts) and the
// memory double the simulated hosts use (memory/net.ts, memory/net.test.ts)
// both run it.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Ref, Scope } from "effect"
import type { Net, Received, Wire } from "../service.ts"

/** A network, and the address its requests come from. */
export interface NetBench {
  readonly net: Net["Service"]
  readonly from: string
}

/** Where every law listens: loopback, as the real network's tests can. */
export const HOST = "127.0.0.1"

const law = (name: string, bench: Effect.Effect<NetBench, never, Scope.Scope>, body: (net: Net["Service"], from: string) => Effect.Effect<void, unknown, Scope.Scope>) =>
  test(name, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const made = yield* bench
          yield* body(made.net, made.from)
        }),
      ),
    ),
  )

const ok = (body: string): Wire => ({ status: 200, body })

const urlOf = (port: number, path: string) => `http://${HOST}:${port}${path}`

export const netLaws = (name: string, bench: Effect.Effect<NetBench, never, Scope.Scope>) =>
  describe(`${name} keeps the network laws`, () => {
    law("a listener on port 0 is given a free port; a post reaches its answer with the path, body, headers and sender, and its answer comes back whole", bench, (net, from) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<Received>>([])
        const port = yield* net.listen({ hostname: HOST, port: 0 }, (request) => Ref.update(seen, (all) => [...all, request]).pipe(Effect.as({ status: 201, body: '{"took":true}' })))
        expect(port).toBeGreaterThan(0)
        const answer = yield* net.post(urlOf(port, "/mail/v1/law"), { headers: { "x-mail-law": "kept" }, body: '{"law":1}' }, 5_000)
        expect(answer).toEqual({ status: 201, body: '{"took":true}' })
        const [request] = yield* Ref.get(seen)
        expect([request?.method, request?.path, request?.body, request?.header("x-mail-law"), Option.isNone(Option.fromNullishOr(request?.header("x-mail-absent"))), request?.address]).toEqual([
          "POST",
          "/mail/v1/law",
          '{"law":1}',
          "kept",
          true,
          from,
        ])
      }),
    )

    law("a second listener on a taken address fails, and binds once the first's scope closes", bench, (net) =>
      Effect.gen(function* () {
        const first = yield* Scope.make()
        const port = yield* net.listen({ hostname: HOST, port: 0 }, () => Effect.succeed(ok('"first"'))).pipe(Scope.provide(first))
        const taken = yield* Effect.flip(net.listen({ hostname: HOST, port }, () => Effect.succeed(ok('"second"'))))
        expect(taken._tag).toBe("NetFailed")
        yield* Scope.close(first, Exit.void)
        expect(yield* net.listen({ hostname: HOST, port }, () => Effect.succeed(ok('"second"')))).toBe(port)
        expect((yield* net.post(urlOf(port, "/"), { headers: {}, body: "" }, 5_000)).body).toBe('"second"')
      }),
    )

    law("a post where nothing listens fails", bench, (net) =>
      Effect.gen(function* () {
        const closed = yield* Scope.make()
        const port = yield* net.listen({ hostname: HOST, port: 0 }, () => Effect.succeed(ok("{}"))).pipe(Scope.provide(closed))
        yield* Scope.close(closed, Exit.void)
        const refused = yield* Effect.flip(net.post(urlOf(port, "/"), { headers: {}, body: "" }, 5_000))
        expect(refused._tag).toBe("NetFailed")
      }),
    )

    law("a post whose answer is slower than its timeout fails, and the listener still answers it to its end", bench, (net) =>
      Effect.gen(function* () {
        const answered = yield* Ref.make(false)
        const port = yield* net.listen({ hostname: HOST, port: 0 }, () =>
          Effect.sleep("300 millis").pipe(Effect.andThen(Ref.set(answered, true)), Effect.as(ok("{}"))),
        )
        const late = yield* Effect.flip(net.post(urlOf(port, "/"), { headers: {}, body: "" }, 50))
        expect(late._tag).toBe("NetFailed")
        expect(yield* Ref.get(answered)).toBe(false)
        yield* Effect.sleep("600 millis")
        expect(yield* Ref.get(answered)).toBe(true)
      }),
    )
  })

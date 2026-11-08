// Several locations share one mail port. A location waiting for its turn
// must unload without waiting for the location that owns the listener.
import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, References, Scope } from "effect"
import { TestClock } from "effect/testing"
import { EMPTY } from "../pairing.ts"
import { PairStore } from "../service.ts"
import { keyed } from "../node/keyed.ts"
import { RETRY, serve } from "./listener.ts"

test("a listener waiting on an occupied port can unload while that port stays occupied", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const occupied = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner") })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const attempted = yield* Deferred.make<void>()
        const logger = Logger.make(({ message }) => {
          if (String(message).includes("not bound")) Deferred.doneUnsafe(attempted, Effect.void)
        })
        const plugin = yield* Scope.make()
        yield* serve(
          { hostname: "127.0.0.1", port: occupied.port! },
          { cards: () => Effect.succeed([]), receive: () => Effect.succeed({ outcome: "unknown" }) },
          keyed,
          () => "test-secret",
        ).pipe(
          Effect.provideService(Scope.Scope, plugin),
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.forkIn(plugin, { startImmediately: true }),
        )
        yield* Deferred.await(attempted)
        const closing = yield* Scope.close(plugin, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust("0 millis")
        const closedWhileOccupied = closing.pollUnsafe()

        // Let a broken acquisition finish too, so the red test cleans up.
        yield* Effect.promise(() => occupied.stop(true))
        yield* TestClock.adjust(RETRY)
        yield* Fiber.join(closing)
        expect(closedWhileOccupied).toBeDefined()
        expect(closedWhileOccupied && Exit.isSuccess(closedWhileOccupied)).toBe(true)
      }),
    ).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(
        Layer.succeed(PairStore, {
          read: Effect.succeed(EMPTY),
          update: (change) => Effect.sync(() => change(EMPTY)[0]),
        }),
      ),
    ),
  ),
)

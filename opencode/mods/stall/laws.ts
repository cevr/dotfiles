// What every implementation of the Captures contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over a fresh,
// empty store per case, made in the case's scope.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { Captures, type Summary } from "./service.ts"

const summary: Summary = {
  stall: { at: 1_700_000_000_000, lagMs: 3_000, rssBefore: 100, rssAfter: 300 },
  pid: 42,
  end: { rss: 200, heapUsed: 50, heapTotal: 80, external: 5 },
  settings: { thresholdMs: 2_000, captureMs: 10_000, windowMs: 30_000 },
}

const sorted = (names: ReadonlyArray<string>) => [...names].sort()

export const capturesLaws = (name: string, fresh: Effect.Effect<Layer.Layer<Captures>, never, Scope.Scope>) => {
  /** `body` over a fresh store. */
  const law = <A, E>(body: Effect.Effect<A, E, Captures>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(fresh, (layer) => Effect.provide(body, layer))))

  describe(`${name} keeps the Captures laws`, () => {
    test("an empty store lists nothing", () =>
      law(
        Effect.gen(function* () {
          const captures = yield* Captures
          expect(yield* captures.names).toEqual([])
        }),
      ))

    test("a written capture lists its profile and its summary, and answers the profile's path", () =>
      law(
        Effect.gen(function* () {
          const captures = yield* Captures
          const path = yield* captures.write("stall-a", '{"nodes":[]}', summary)
          expect(path).toEndWith("stall-a.cpuprofile")
          expect(sorted(yield* captures.names)).toEqual(["stall-a.cpuprofile", "stall-a.json"])
        }),
      ))

    test("removing names deletes those alone, and a name already gone is no failure", () =>
      law(
        Effect.gen(function* () {
          const captures = yield* Captures
          yield* captures.write("stall-a", "{}", summary)
          yield* captures.write("stall-b", "{}", summary)
          yield* captures.remove(["stall-a.cpuprofile", "stall-a.json", "stall-gone.json"])
          expect(sorted(yield* captures.names)).toEqual(["stall-b.cpuprofile", "stall-b.json"])
        }),
      ))
  })
}

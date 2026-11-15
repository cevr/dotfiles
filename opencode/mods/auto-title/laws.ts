// What every implementation of the Tracks contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { fresh } from "./retitle.ts"
import { Tracks } from "./service.ts"

export const tracksLaws = (name: string, make: () => Layer.Layer<Tracks>) =>
  describe(`${name} owes the Tracks laws`, () => {
    const run = (body: Effect.Effect<void, never, Tracks>) => Effect.runPromise(Effect.provide(body, make()))

    test("a session never put reads as none", () =>
      run(
        Effect.gen(function* () {
          expect(yield* (yield* Tracks).get("ses_none")).toEqual(Option.none())
        }),
      ))

    test("a put reads back as put, per session, and the newest put wins", () =>
      run(
        Effect.gen(function* () {
          const tracks = yield* Tracks
          const pinned = { ...fresh(1_000), pinned: true, turns: 3 }
          yield* tracks.put("ses_a", fresh(0))
          yield* tracks.put("ses_a", pinned)
          yield* tracks.put("ses_b", fresh(5))
          expect([yield* tracks.get("ses_a"), yield* tracks.get("ses_b")]).toEqual([Option.some(pinned), Option.some(fresh(5))])
        }),
      ))

    test("a removed session reads as none, the others stay", () =>
      run(
        Effect.gen(function* () {
          const tracks = yield* Tracks
          yield* tracks.put("ses_a", fresh(0))
          yield* tracks.put("ses_b", fresh(0))
          yield* tracks.remove("ses_a")
          expect([yield* tracks.get("ses_a"), yield* tracks.get("ses_b")]).toEqual([Option.none(), Option.some(fresh(0))])
        }),
      ))
  })

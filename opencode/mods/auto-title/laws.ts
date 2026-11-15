// What every implementation of the Tracks contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer,
// registering each case through its own Effect test (`effectTest` in
// sim-tui/effect-test.ts), so the laws run no Effect by hand.
import { describe, expect } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { fresh } from "./retitle.ts"
import { Tracks } from "./service.ts"

/** Registers a test whose body is an Effect. */
export type EffectTest = (name: string, body: Effect.Effect<void>, timeoutMs: number) => void

const LIMIT = 5_000

export const tracksLaws = (name: string, make: () => Layer.Layer<Tracks>, effectTest: EffectTest) =>
  describe(`${name} owes the Tracks laws`, () => {
    const law = (title: string, body: Effect.Effect<void, never, Tracks>) => effectTest(title, Effect.provide(body, make()), LIMIT)

    law(
      "a session never put reads as none",
      Effect.gen(function* () {
        expect(yield* (yield* Tracks).get("ses_none")).toEqual(Option.none())
      }),
    )

    law(
      "a put reads back as put, per session, and the newest put wins",
      Effect.gen(function* () {
        const tracks = yield* Tracks
        const pinned = { ...fresh(1_000), pinned: true, turns: 3 }
        yield* tracks.put("ses_a", fresh(0))
        yield* tracks.put("ses_a", pinned)
        yield* tracks.put("ses_b", fresh(5))
        expect([yield* tracks.get("ses_a"), yield* tracks.get("ses_b")]).toEqual([Option.some(pinned), Option.some(fresh(5))])
      }),
    )

    law(
      "a removed session reads as none, the others stay",
      Effect.gen(function* () {
        const tracks = yield* Tracks
        yield* tracks.put("ses_a", fresh(0))
        yield* tracks.put("ses_b", fresh(0))
        yield* tracks.remove("ses_a")
        expect([yield* tracks.get("ses_a"), yield* tracks.get("ses_b")]).toEqual([Option.none(), Option.some(fresh(0))])
      }),
    )
  })

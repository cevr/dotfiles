// A browser in memory, for the viewer's tests: each page's current shot set
// by the test (a page with none does not answer), and each shot told to
// the test as it is taken (to a queue, say), so it can wait for shots without a clock.
import { Effect, Layer, Option, Ref } from "effect"
import { Browser, type Shot, ShotFailed } from "../service.ts"

/** The PNG each URL shoots as now; a URL left out does not answer. */
export type Pages = ReadonlyMap<string, Uint8Array>

/** The browser over `pages`, telling `taken` each shot. */
export const layer = (pages: Ref.Ref<Pages>, taken: (shot: Shot) => Effect.Effect<unknown> = () => Effect.void) =>
  Layer.succeed(
    Browser,
    Browser.of({
      shoot: Effect.fn("MemoryBrowser.shoot")(function* (shot: Shot) {
        yield* taken(shot)
        return yield* Option.match(Option.fromUndefinedOr((yield* Ref.get(pages)).get(shot.url)), {
          onNone: () => Effect.fail(new ShotFailed({ url: shot.url, message: `cannot reach ${shot.url}: ECONNREFUSED` })),
          onSome: Effect.succeed,
        })
      }),
    }),
  )

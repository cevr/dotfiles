// A browser in memory, for the viewer's tests: each page's current shot set
// by the test (a page with none does not answer), and each shot told to
// the test as it is taken (to a queue, say), so it can wait for shots without a clock.
// A live tab is the test's own (`tab`), told the address and setup it was opened with.
import { Effect, Layer, Option, Ref, type Scope } from "effect"
import { Browser, type Command, type Shot, ShotFailed, type Tab } from "../service.ts"

/** The PNG each URL shoots as now; a URL left out does not answer. */
export type Pages = ReadonlyMap<string, Uint8Array>

/** How the memory browser opens a live tab; by default it cannot. */
export type Opens = (url: string, setup: ReadonlyArray<Command>) => Effect.Effect<Tab, ShotFailed, Scope.Scope>

const noTabs: Opens = (url) => Effect.fail(new ShotFailed({ url, message: "no live tab in this test" }))

/** The browser over `pages`, telling `taken` each shot, opening live tabs with `opens`. */
export const layer = (pages: Ref.Ref<Pages>, taken: (shot: Shot) => Effect.Effect<unknown> = () => Effect.void, opens: Opens = noTabs) =>
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
      open: opens,
    }),
  )

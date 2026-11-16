// Simulators in memory, for the viewer's tests: the booted ones and each
// one's current screen, set by the test, or a reason nothing can be reached
// (`unreachable`). Each screenshot is told to the test as it is taken, so it
// can wait for the viewer's next look without a clock. Every host reads the
// same world.
import { Effect, Layer, Option, Ref } from "effect"
import { SimFailed, type SimHost, Simulators } from "../service.ts"
import type { Device } from "../sim.ts"

/** What the memory simulators hold. */
export interface World {
  readonly unreachable: Option.Option<string>
  readonly booted: ReadonlyArray<Device>
  readonly screens: ReadonlyMap<string, Uint8Array>
}

/** No simulator booted, and reachable. */
export const empty: World = { unreachable: Option.none(), booted: [], screens: new Map() }

/** The simulators over `world`, telling `taken` the udid of each screenshot. */
export const layer = (world: Ref.Ref<World>, taken: (udid: string) => Effect.Effect<unknown> = () => Effect.void) => {
  const reachable = Effect.flatMap(Ref.get(world), (now) =>
    Option.match(now.unreachable, { onNone: () => Effect.succeed(now), onSome: (message) => Effect.fail(new SimFailed({ message })) }),
  )
  const host: SimHost = {
    booted: Effect.map(reachable, (now) => now.booted),
    screenshot: (udid) =>
      Effect.andThen(
        taken(udid),
        Effect.flatMap(reachable, (now) =>
          Option.match(Option.fromUndefinedOr(now.screens.get(udid)), {
            onNone: () => Effect.fail(new SimFailed({ message: `simctl io ${udid} screenshot failed: device not booted` })),
            onSome: Effect.succeed,
          }),
        ),
      ),
  }
  return Layer.succeed(Simulators, Simulators.of({ at: () => host }))
}

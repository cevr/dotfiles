// Checkouts held in memory: the checkouts a test names (a directory is in the
// one whose root holds it, the deepest when they nest), the warm sources, and
// what it cannot read: the directories under a path in `unreadable`, and the
// warm sources when `sourcesFail` is set at the time they are asked.
import { Array as Arr, Effect, Layer, Order } from "effect"
import { type Checkout, CheckoutUnknown, Checkouts, type WarmSource } from "../service.ts"

export interface World {
  readonly checkouts: ReadonlyArray<Checkout>
  readonly warmSources?: ReadonlyArray<WarmSource>
  /** Directories under which a checkout cannot be read. */
  readonly unreadable?: ReadonlyArray<string>
  /** The warm sources cannot be listed. */
  readonly sourcesFail?: boolean
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

/** The deepest root first. */
const deepestFirst = Order.mapInput(Order.flip(Order.Number), (checkout: Checkout) => checkout.root.length)

export const layer = (world: World) =>
  Layer.succeed(
    Checkouts,
    Checkouts.of({
      of: (directory) =>
        Effect.suspend(() => {
          if (Arr.some(world.unreadable ?? [], (path) => under(directory, path)))
            return Effect.fail(new CheckoutUnknown({ path: directory, message: "permission denied" }))
          const holding = world.checkouts.filter((checkout) => under(directory, checkout.root))
          return Effect.succeed(Arr.head(Arr.sort(holding, deepestFirst)))
        }),
      warmSources: Effect.suspend(() => {
        if (world.sourcesFail === true) return Effect.fail(new CheckoutUnknown({ path: "workrift sources", message: "workrift sources exited 1" }))
        return Effect.succeed(world.warmSources ?? [])
      }),
    }),
  )

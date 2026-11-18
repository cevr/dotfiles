// Reservations held in memory: the workspaces being made of each base a test
// names (a directory is in the base whose path holds it, or one of its
// workspaces' folders), and the directories under which the registry cannot
// be read.
import { Effect, Layer } from "effect"
import { type Reservation, Reservations, ReservationsUnknown } from "../service.ts"

export interface World {
  /** Each base's path, with the workspaces of it being made. */
  readonly bases: Readonly<Record<string, ReadonlyArray<Reservation>>>
  /** Directories under which the registry cannot be read. */
  readonly unreadable?: ReadonlyArray<string>
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export const layer = (world: World) =>
  Layer.succeed(
    Reservations,
    Reservations.of({
      of: (directory) =>
        Effect.suspend(() => {
          if ((world.unreadable ?? []).some((path) => under(directory, path)))
            return Effect.fail(new ReservationsUnknown({ directory, message: "the registry is locked" }))
          return Effect.succeed(Object.entries(world.bases).flatMap(([base, making]) => [...making].filter(() => under(directory, base))))
        }),
    }),
  )

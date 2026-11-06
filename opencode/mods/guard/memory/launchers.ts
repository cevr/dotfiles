// Launchers and Scopes held in memory: the launchers written go into a map
// the test reads, at `/launchers/<n>/<name>`; whether a scope is available is
// the test's to say.
import { Effect, Layer } from "effect"
import { Launchers, LauncherUnavailable, Scopes } from "../service.ts"

/** Each launcher written, by its path; `unwritable` makes every write fail. */
export interface World {
  readonly written: Map<string, string>
  readonly unwritable?: boolean
  readonly scope: boolean
}

export const layer = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(
      Launchers,
      Launchers.of({
        install: (name, script) =>
          Effect.suspend(() => {
            if (world.unwritable === true) return Effect.fail(new LauncherUnavailable({ message: "EACCES: permission denied" }))
            const known = [...world.written].find(([, text]) => text === script)?.[0]
            const path = known ?? `/launchers/${world.written.size}/${name}`
            world.written.set(path, script)
            return Effect.succeed(path)
          }),
      }),
    ),
    Layer.succeed(Scopes, Scopes.of({ available: Effect.succeed(world.scope) })),
  )

// RepoRoots held in memory: the repositories a test names, and the paths it
// cannot read. A path inside a repository is not its root.
import { Effect, Layer } from "effect"
import { RepoRootUnknown, RepoRoots } from "../service.ts"

export interface World {
  readonly repos: ReadonlyArray<string>
  readonly unreadable?: ReadonlyArray<string>
}

export const layer = (world: World) =>
  Layer.succeed(
    RepoRoots,
    RepoRoots.of({
      isRoot: (path) =>
        world.unreadable?.includes(path)
          ? Effect.fail(new RepoRootUnknown({ path, message: "permission denied" }))
          : Effect.succeed(world.repos.includes(path)),
    }),
  )

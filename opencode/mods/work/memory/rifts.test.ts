import { Effect, Option } from "effect"
import { riftsLaws, sessionDirectoriesLaws } from "../laws.ts"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"

riftsLaws("memory Rifts", () =>
  Effect.sync(() => {
    const state = MemoryRifts.world(["/code/app"])
    const missing = "0".repeat(40)
    state.commitOf = (at) => Option.liftPredicate(at, (commit) => commit !== missing)
    let stashes = 0
    return {
      layer: MemoryRifts.layer(state),
      source: "/code/app",
      inside: "/code/app/src",
      plain: "/elsewhere",
      commit: (path: string) =>
        Effect.sync(() => MemoryRifts.change(state, path, (workspace) => ({ ...workspace, unpushed: [...workspace.unpushed, "def5678 work"] }))),
      dirty: (path: string) =>
        Effect.sync(() => MemoryRifts.change(state, path, (workspace) => ({ ...workspace, uncommitted: [...workspace.uncommitted, "?? new.txt"] }))),
      stash: (path: string) => Effect.sync(() => MemoryRifts.stash(state, path, `stash${++stashes}`)),
      switchTo: (path: string, branch: string) => Effect.sync(() => MemoryRifts.change(state, path, (workspace) => ({ ...workspace, branch }))),
      head: Effect.succeed("abc1234abc1234abc1234abc1234abc1234abc1"),
      missing,
    }
  }),
)

sessionDirectoriesLaws("memory SessionDirectories", (world) => MemorySessionDirectories.layer(world))

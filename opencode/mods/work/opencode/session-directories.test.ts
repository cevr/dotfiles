// OpenCode's SessionDirectories over a stand-in for the host's `session.get`,
// which fails for a session it does not know.
import { Effect } from "effect"
import { sessionDirectoriesLaws } from "../laws.ts"
import * as OpenCodeSessionDirectories from "./session-directories.ts"

sessionDirectoriesLaws("OpenCode's SessionDirectories", (world) =>
  OpenCodeSessionDirectories.layer((sessionID) => {
    const directory = Object.hasOwn(world, sessionID) ? world[sessionID] : undefined
    return directory === undefined ? Effect.fail(new Error(`Session not found: ${sessionID}`)) : Effect.succeed(directory)
  }),
)

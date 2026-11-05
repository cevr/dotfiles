// SessionDirectories over a stand-in for OpenCode's session lookup: the
// law's world maps session IDs to directories, and a session it does not hold
// fails the way the host does, with an error naming it.
import { Effect } from "effect"
import { sessionDirectoriesLaws } from "../laws.ts"
import * as OpencodeSessions from "./session-directories.ts"

class SessionNotFound extends Error {}

sessionDirectoriesLaws("OpenCode's SessionDirectories", (world) =>
  OpencodeSessions.layer((sessionID) => {
    const directory = world[sessionID]
    return directory === undefined ? Effect.fail(new SessionNotFound(`Session not found: ${sessionID}`)) : Effect.succeed(directory)
  }),
)

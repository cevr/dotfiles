// SessionDirectories held in memory: OpenCode's (opencode/session-directories.ts)
// over a lookup in a record, which fails for a session it does not hold, as
// the host's `session.get` does.
import { Effect } from "effect"
import * as OpenCodeSessionDirectories from "../opencode/session-directories.ts"

/** Each session the host knows, to its directory; any other cannot be read. */
export const layer = (sessions: Readonly<Record<string, string>>) =>
  OpenCodeSessionDirectories.layer((sessionID) => {
    const directory = Object.hasOwn(sessions, sessionID) ? sessions[sessionID] : undefined
    return directory === undefined ? Effect.fail(`no session ${sessionID}`) : Effect.succeed(directory)
  })

// Sessions held in memory: OpenCode's sessions (opencode/sessions.ts) over a
// lookup in a record, which fails for a session it does not hold, as the
// host's `session.get` does.
import { Effect } from "effect"
import * as OpenCodeSessions from "../opencode/sessions.ts"

/** The sessions the host knows; any other cannot be read. */
export const layer = (sessions: Readonly<Record<string, OpenCodeSessions.Session>>) =>
  OpenCodeSessions.layer((sessionID) => {
    const session = Object.hasOwn(sessions, sessionID) ? sessions[sessionID] : undefined
    return session === undefined ? Effect.fail(`no session ${sessionID}`) : Effect.succeed(session)
  })

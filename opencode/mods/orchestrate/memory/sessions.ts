// Sessions held in memory: OpenCode's sessions (opencode/sessions.ts) over a
// lookup in a record, which fails for a session it does not hold, as the
// host's `session.get` does. A session's `lastWords` are its one assistant
// message's text.
import { Effect } from "effect"
import * as OpenCodeSessions from "../opencode/sessions.ts"

/** A session the host knows, with the words its last answer wrote. */
export interface Session extends OpenCodeSessions.Session {
  readonly lastWords?: string
}

/** The sessions the host knows; any other cannot be read. */
export const layer = (sessions: Readonly<Record<string, Session>>) => {
  const get = (sessionID: string): Effect.Effect<Session, string> => {
    const session = Object.hasOwn(sessions, sessionID) ? sessions[sessionID] : undefined
    return session === undefined ? Effect.fail(`no session ${sessionID}`) : Effect.succeed(session)
  }
  return OpenCodeSessions.layer(get, (sessionID) =>
    get(sessionID).pipe(
      Effect.map((session) => (session.lastWords === undefined ? [] : [{ type: "assistant", content: [{ type: "text", text: session.lastWords }] }])),
    ),
  )
}

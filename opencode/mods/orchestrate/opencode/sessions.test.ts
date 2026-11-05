// OpenCode's sessions over a stand-in for the host's `session.get`, which
// fails for a session it does not know.
import { Effect } from "effect"
import { sessionsLaws } from "../laws.ts"
import * as OpenCodeSessions from "./sessions.ts"

sessionsLaws("OpenCode's Sessions", (world) =>
  OpenCodeSessions.layer((sessionID) => {
    const session = Object.hasOwn(world, sessionID) ? world[sessionID] : undefined
    return session === undefined ? Effect.fail(new Error(`Session not found: ${sessionID}`)) : Effect.succeed(session)
  }),
)

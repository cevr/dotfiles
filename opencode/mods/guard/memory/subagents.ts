// Subagents held in memory: OpenCode's (opencode/subagents.ts) over a lookup
// in a record, which fails for a session it does not hold, as the host's
// `session.get` does.
import { Effect } from "effect"
import * as OpenCodeSubagents from "../opencode/subagents.ts"

/** Each session the host knows, to its parent (undefined for a root session); any other cannot be read. */
export const layer = (sessions: Readonly<Record<string, string | undefined>>) =>
  OpenCodeSubagents.layer((sessionID) =>
    Object.hasOwn(sessions, sessionID) ? Effect.succeed(sessions[sessionID]) : Effect.fail(`no session ${sessionID}`),
  )

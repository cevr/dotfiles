// OpenCode's sessions over a stand-in host that answers from the laws' world:
// an unknown session fails as the host's `session.get` does, an unknown agent
// as its `agent.get` does.
import { Effect } from "effect"
import { sessionsLaws } from "../laws.ts"
import * as OpenCodeSessions from "./sessions.ts"

sessionsLaws("OpenCode's Sessions", (world) =>
  OpenCodeSessions.layer({
    session: (session) => {
      const info = world.sessions[session]
      return info === undefined ? Effect.fail(new Error(`Session not found: ${session}`)) : Effect.succeed(info)
    },
    agentRules: (agent) => {
      const rules = world.agents[agent]
      return rules === undefined ? Effect.fail(new Error(`Agent not found: ${agent}`)) : Effect.succeed(rules)
    },
  }),
)

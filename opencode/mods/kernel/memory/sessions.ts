// OpenCode's sessions and agents held in memory, for the plugin's seam tests:
// the sessions a test names, each with its directory and own rules, and the
// agents' rules. A session the test did not name cannot be read.
import { Effect, Layer } from "effect"
import { Sessions, SessionUnreadable } from "../service.ts"
import type { Rule } from "../tools.ts"

export interface World {
  readonly sessions: Readonly<Record<string, { readonly directory: string; readonly permissions?: ReadonlyArray<Rule> }>>
  readonly agents: Readonly<Record<string, ReadonlyArray<Rule>>>
}

export const layer = (world: World) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      scope: (session, agent) => {
        const info = world.sessions[session]
        if (info === undefined) return Effect.fail(new SessionUnreadable({ session, message: `Session not found: ${session}` }))
        return Effect.succeed({ directory: info.directory, rules: [...(world.agents[agent] ?? []), ...(info.permissions ?? [])] })
      },
    }),
  )

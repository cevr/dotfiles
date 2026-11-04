// OpenCode's sessions and agents, as the kernel reads them: the session's
// working directory, and the permission rules a cell's tools are filtered by.
// `fromContext` reads them through the plugin context; `layer` takes them as
// plain functions, so the laws run it over a stand-in host.
import { Agent, type Plugin } from "@opencode/plugin/effect"
import { Effect, Layer } from "effect"
import { Sessions, SessionUnreadable } from "../kernel/service.ts"
import { messageOf, type Rule } from "../kernel/tools.ts"

/** A session as the kernel reads it. */
export interface SessionInfo {
  readonly directory: string
  readonly permissions?: ReadonlyArray<Rule> | undefined
}

/** The host's reads. */
export interface Host {
  readonly session: (session: string) => Effect.Effect<SessionInfo, unknown>
  readonly agentRules: (agent: string, directory: string) => Effect.Effect<ReadonlyArray<Rule>, unknown>
}

export const layer = (host: Host) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      scope: Effect.fn("Sessions.scope")(function* (session, agent) {
        const info = yield* host
          .session(session)
          .pipe(Effect.mapError((cause) => new SessionUnreadable({ session, message: messageOf(cause) })))
        const agentRules = yield* host.agentRules(agent, info.directory).pipe(Effect.orElseSucceed((): ReadonlyArray<Rule> => []))
        return { directory: info.directory, rules: [...agentRules, ...(info.permissions ?? [])] }
      }),
    }),
  )

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The host's reads through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    session: (sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
        Effect.map((session) => ({ directory: session.location.directory, permissions: session.permissions })),
      ),
    agentRules: (agentID, directory) =>
      ctx.agent.get({ agentID: Agent.ID.make(agentID), location: { directory } }).pipe(Effect.map((agent) => agent.data.permissions)),
  })

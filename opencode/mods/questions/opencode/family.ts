// Who a session is, through OpenCode's plugin context. `layer` reads through
// a plain view of the host's `session.get`, so a test runs it over a stand-in;
// `fromContext` takes the view from the plugin context.
//
// Where each fact comes from, in the fork: `ctx.session.get` returns the
// session's `Session.Info` (packages/schema/src/session.ts `Info`): its
// `parentID` for a subagent, its `title` (a subagent's is the description it
// was started with, packages/core/src/tool/plugin/subagent.ts `title:
// input.description`) and its `agent`. A session it does not have fails.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer } from "effect"
import { Family, type SessionInfo } from "../service.ts"

/** The host's sessions, as far as the questions read them. */
export interface Host {
  readonly get: (sessionID: string) => Effect.Effect<{ readonly id: string; readonly parentID?: string; readonly title?: string; readonly agent?: string }, unknown>
}

export const layer = (host: Host) =>
  Layer.succeed(Family, {
    info: (sessionID) =>
      host.get(sessionID).pipe(
        Effect.map(
          (session): SessionInfo => ({
            id: session.id,
            ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.agent === undefined ? {} : { agent: session.agent }),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
  })

type Input = Parameters<Plugin.Context["session"]["get"]>[0]

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) => layer({ get: (sessionID) => ctx.session.get({ sessionID: sessionID as Input["sessionID"] }) })

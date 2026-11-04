// Sessions as OpenCode reports them. A session it cannot read answers
// undefined: the guard then treats it as a main session with no agent.
import { Effect, Layer } from "effect"
import { Sessions } from "../domain/ToolCall/Sessions.external.ts"

/** What the guard reads of a session. */
export interface Session {
  readonly parentID?: string
  readonly agent?: string
}

/** OpenCode's session lookup, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<Session, unknown>

const orNone = Effect.catchCause(() => Effect.succeed(undefined))

export const layer = (get: Get) =>
  Layer.succeed(Sessions, {
    parentOf: Effect.fn("Sessions.parentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).parentID || undefined
    }, orNone),
    agentOf: Effect.fn("Sessions.agentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).agent || undefined
    }, orNone),
  })

/** The sessions the host knows; any other cannot be read. */
export const layerTest = (sessions: Readonly<Record<string, Session>>) =>
  Layer.effect(Sessions, Effect.sync(() => {
    const get = (sessionID: string) => (Object.hasOwn(sessions, sessionID) ? sessions[sessionID] : undefined)
    return Sessions.of({
      parentOf: (sessionID) => Effect.sync(() => get(sessionID)?.parentID || undefined),
      agentOf: (sessionID) => Effect.sync(() => get(sessionID)?.agent || undefined),
    })
  }))

// Subagents as OpenCode records them: a session with a `parentID`. A session
// the host cannot read fails SessionUnreadable.
import { Effect, Layer } from "effect"
import { SessionUnreadable, Subagents } from "../service.ts"

/** OpenCode's lookup of a session's parent, as the plugin calls it: undefined for a root session. */
export type GetParent = (sessionID: string) => Effect.Effect<string | undefined, unknown>

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

export const layer = (getParent: GetParent) =>
  Layer.succeed(
    Subagents,
    Subagents.of({
      isSubagent: Effect.fn("Subagents.isSubagent")(function* (sessionID: string) {
        const parent = yield* getParent(sessionID).pipe(Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })))
        return parent !== undefined
      }),
    }),
  )

// Sessions as OpenCode reports them: a session's project id, which every clone,
// worktree and Rift of one repository shares, and whether it has a parent. A
// session the host cannot read fails SessionUnreadable.
import { Effect, Layer } from "effect"
import { Sessions, SessionUnreadable } from "../service.ts"

/** The part of OpenCode's session info memory reads. */
export interface SessionView {
  readonly projectID: string
  readonly location: { readonly directory: string }
  readonly parentID?: string | undefined
}

/** OpenCode's session lookup, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<SessionView, unknown>

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

export const layer = (get: Get) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      facts: Effect.fn("Sessions.facts")(function* (sessionID: string) {
        const session = yield* get(sessionID).pipe(Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })))
        return { project: session.projectID, directory: session.location.directory, child: session.parentID !== undefined }
      }),
    }),
  )

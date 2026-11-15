// SessionDirectories as OpenCode reports them (as the guard reads them): a session's location
// directory. A session the host cannot read fails SessionUnreadable.
import { Effect, Layer } from "effect"
import { SessionDirectories, SessionUnreadable } from "../service.ts"

/** OpenCode's lookup of a session's directory, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<string, unknown>

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

export const layer = (get: Get) =>
  Layer.succeed(
    SessionDirectories,
    SessionDirectories.of({
      directoryOf: Effect.fn("SessionDirectories.directoryOf")(function* (sessionID: string) {
        return yield* get(sessionID).pipe(Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })))
      }),
    }),
  )

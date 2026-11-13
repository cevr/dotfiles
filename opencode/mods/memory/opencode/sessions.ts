// Sessions as OpenCode reports them: a session's project id, which every clone,
// worktree and Rift of one repository shares, whether it has a parent, and the
// digest the session holds in its metadata (`HELD`). A session the host cannot
// read or update fails SessionUnreadable.
import { Effect, Layer, Option, Schema } from "effect"
import { Sessions, SessionUnreadable } from "../service.ts"

/** The session metadata key that holds a digest the memory file could not keep. */
export const HELD = "memory.digest"

/** A session's metadata, as OpenCode keeps it: JSON by key. */
export type Metadata = { readonly [key: string]: Schema.Json }

/** The part of OpenCode's session info memory reads. */
export interface SessionView {
  readonly projectID: string
  readonly location: { readonly directory: string }
  readonly parentID?: string | undefined
  readonly metadata?: Metadata
}

/** OpenCode's session lookup, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<SessionView, unknown>

/** OpenCode's session update: the session's metadata becomes `metadata`, whole. */
export type Update = (sessionID: string, metadata: Metadata) => Effect.Effect<unknown, unknown>

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

const heldOf = (metadata: Metadata) => Option.liftPredicate(metadata[HELD], Schema.is(Schema.String))

export const layer = (get: Get, update: Update) => {
  const read = (sessionID: string) => get(sessionID).pipe(Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })))
  return Layer.succeed(
    Sessions,
    Sessions.of({
      facts: Effect.fn("Sessions.facts")(function* (sessionID: string) {
        const session = yield* read(sessionID)
        return {
          project: session.projectID,
          directory: session.location.directory,
          child: session.parentID !== undefined,
          held: Option.flatMap(Option.fromNullishOr(session.metadata), heldOf),
        }
      }),
      // The session's other metadata stays: an update replaces it whole.
      hold: Effect.fn("Sessions.hold")(function* (sessionID: string, digest: string) {
        const session = yield* read(sessionID)
        yield* update(sessionID, { ...session.metadata, [HELD]: digest }).pipe(
          Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })),
        )
      }),
    }),
  )
}

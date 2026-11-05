// The contract mail needs from outside: the server's sessions, read as cards,
// and a way into a session's inbox. What every implementation owes is in
// laws.ts.
import { Context, type Effect, type Option, Schema } from "effect"
import type { SessionCard } from "./directory.ts"
import type { Letter } from "./letter.ts"

/** The server's sessions could not be read. */
export class SessionsUnreadable extends Schema.TaggedError<SessionsUnreadable>()("SessionsUnreadable", { message: Schema.String }) {}

/** The host would not take the letter into the session's inbox. */
export class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()("DeliveryRefused", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/**
 * The sessions of this server, and only this one.
 * - `get`: the session with that id; none when the server has no such session.
 * - `list`: the newest sessions by last activity, archived ones left out; main
 *   sessions only unless `children`.
 * - `deliver`: the letter into the session's inbox as a synthetic message
 *   delivered as a steer (read at its running execution's next step); `wake`
 *   starts an idle session to read it, and without it the letter waits for
 *   the session's next turn.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly get: (sessionID: string) => Effect.Effect<Option.Option<SessionCard>, SessionsUnreadable>
    readonly list: (scope: { readonly children: boolean }) => Effect.Effect<ReadonlyArray<SessionCard>, SessionsUnreadable>
    readonly deliver: (sessionID: string, letter: Letter, wake: boolean) => Effect.Effect<void, DeliveryRefused>
  }
>()("dotfiles-opencode/mail/Sessions") {}

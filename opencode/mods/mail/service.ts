// The contracts mail needs from outside: the server's sessions, read as cards,
// and a way into a session's inbox; the paired hosts; and where the pairing
// is kept. What every Sessions implementation owes is in laws.ts.
import { Context, type Effect, type Option, Schema } from "effect"
import type { SessionCard } from "./directory.ts"
import type { Letter } from "./letter.ts"
import type { Pairs } from "./pairing.ts"
import type { Arrival, Parcel } from "./peer.ts"

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

/** A paired host did not answer, refused the request, or answered something else. */
export class PeerUnreachable extends Schema.TaggedError<PeerUnreachable>()("PeerUnreachable", {
  peer: Schema.String,
  message: Schema.String,
}) {}

/**
 * The hosts this one is paired with (pairing.ts), each by its mail name.
 * - `names`: the paired hosts now, in name order; none before any pairing.
 * - `sessions`: a peer's sessions as its own `Sessions.list` gives them.
 * - `deliver`: hand a peer a parcel for one of its sessions; the peer
 *   composes and delivers the letter, or says it has no such session.
 */
export class Peers extends Context.Service<
  Peers,
  {
    readonly names: Effect.Effect<ReadonlyArray<string>>
    readonly sessions: (peer: string, scope: { readonly children: boolean }) => Effect.Effect<ReadonlyArray<SessionCard>, PeerUnreachable>
    readonly deliver: (peer: string, parcel: Parcel) => Effect.Effect<Arrival, PeerUnreachable>
  }
>()("dotfiles-opencode/mail/Peers") {}

/** The pairing state could not be written. */
export class PairsUnwritable extends Schema.TaggedError<PairsUnwritable>()("PairsUnwritable", { message: Schema.String }) {}

/**
 * Where a host keeps its pairing (`Pairs`): readable by its owner only, since
 * it holds each peer's secret. A missing or unreadable store reads empty;
 * `update` reads, applies `change` and writes the result whole.
 */
export class PairStore extends Context.Service<
  PairStore,
  {
    readonly read: Effect.Effect<Pairs>
    readonly update: <A>(change: (pairs: Pairs) => readonly [A, Pairs]) => Effect.Effect<A, PairsUnwritable>
  }
>()("dotfiles-opencode/mail/PairStore") {}

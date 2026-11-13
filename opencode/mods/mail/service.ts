// The contracts mail needs from outside: the server's sessions, read as cards,
// and a way into a session's inbox; the paired hosts; and where the pairing
// is kept. What every Sessions implementation owes is in laws.ts.
import { Context, type Effect, type Option, Schema, type Scope } from "effect"
import type { SessionCard } from "./directory.ts"
import type { Letter } from "./letter.ts"
import type { Incoming, Pairs } from "./pairing.ts"
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

/** A request as a listener reads it, with the address it came from. */
export interface Received extends Incoming {
  readonly address: string
}

/** An HTTP answer: its status and its JSON body as text. */
export interface Wire {
  readonly status: number
  readonly body: string
}

/** Where a listener binds: one address, and a port (0: any free one). */
export interface Address {
  readonly hostname: string
  readonly port: number
}

/** The network refused: an address taken, nothing listening, or no answer in time. */
export class NetFailed extends Schema.TaggedError<NetFailed>()("NetFailed", { message: Schema.String }) {}

/**
 * The network between paired hosts. What every implementation owes is in http/net-laws.ts.
 * - `listen`: answer the requests to `address` with `answer` until the scope closes; the
 *   port bound (a free one for port 0). Fails while another listener holds the address.
 * - `post`: one POST of `body` with `headers` to `url`, and its answer; fails when nothing
 *   listens there or no answer comes within `timeoutMs`.
 */
export class Net extends Context.Service<
  Net,
  {
    readonly listen: (address: Address, answer: (request: Received) => Effect.Effect<Wire>) => Effect.Effect<number, NetFailed, Scope.Scope>
    readonly post: (url: string, request: { readonly headers: Readonly<Record<string, string>>; readonly body: string }, timeoutMs: number) => Effect.Effect<Wire, NetFailed>
  }
>()("dotfiles-opencode/mail/Net") {}

/** Random tokens for codes, secrets and nonces: `bytes` random bytes as base64url. */
export class Tokens extends Context.Service<Tokens, { readonly token: (bytes: number) => Effect.Effect<string> }>()("dotfiles-opencode/mail/Tokens") {}

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

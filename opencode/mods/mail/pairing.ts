// Pairing: how two hosts' mail plugins come to trust each other, and how each
// request between them is checked. A host invites (a one-time code, kept only
// as its hash, good for ten minutes); the other host joins with that code and
// its own name and address; the inviter answers with a fresh shared secret,
// and both keep the other under its name. Every later request is signed with
// that secret over its method, path, time, a nonce and its body (HMAC-SHA256),
// so a request from an unpaired host, a bad signature, a stale time or a
// replayed nonce is refused.
//
// The rules here are pure; the keyed hash and the random values come from
// outside (`Keyed`, implemented in node/), so the domain imports no crypto.
import { Schema } from "effect"

/** A paired host: where its mail listener answers, the secret both sides hold, and when it was paired. */
export const Peer = Schema.Struct({ url: Schema.String, secret: Schema.String, paired: Schema.Number })
export type Peer = typeof Peer.Type

/** An open invite, by its code's hash. */
export const Invite = Schema.Struct({ hash: Schema.String, expires: Schema.Number })
export type Invite = typeof Invite.Type

/**
 * What a host keeps of its pairing: its own mail name and listener address
 * (once known), its peers by name and its open invites.
 */
export const Pairs = Schema.Struct({
  name: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  peers: Schema.Record(Schema.String, Peer),
  invites: Schema.Array(Invite),
})
export type Pairs = typeof Pairs.Type

export const EMPTY: Pairs = { peers: {}, invites: [] }

/** How long an invite's code is good for. */
export const INVITE_MS = 10 * 60_000

/** How far a request's time may be from the receiver's clock; a nonce is remembered twice this long. */
export const SKEW_MS = 60_000

/** The keyed hash and plain hash the rules use (HMAC-SHA256 and SHA-256, both as base64url). */
export interface Keyed {
  readonly mac: (secret: string, text: string) => string
  readonly hash: (text: string) => string
  /** Whether two strings are equal, in constant time. */
  readonly same: (left: string, right: string) => boolean
}

/** A pairing or a request was refused; `reason` is what the log and the caller read. */
export type Refused = { readonly ok: false; readonly reason: string }
const refused = (reason: string): Refused => ({ ok: false, reason })

/** A mail name: letters, digits, `.`, `_` and `-`, as a host name is. */
export const validName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)

/** `pairs` with an invite for `code` added under `name` (kept when one is already set), the expired ones dropped. */
export const invited = (pairs: Pairs, name: string, code: string, now: number, keyed: Keyed): Pairs => ({
  ...pairs,
  name: pairs.name ?? name,
  invites: [...pairs.invites.filter((invite) => invite.expires > now), { hash: keyed.hash(code), expires: now + INVITE_MS }],
})

/** What the joining host sends: the invite's code, its mail name and its listener's address. */
export interface PairAsk {
  readonly code: string
  readonly name: string
  readonly url: string
}

/** The inviter takes `ask`: the invite is used up and the joiner kept as a peer with `secret`, which goes back with the inviter's name. */
export const accept = (
  pairs: Pairs,
  ask: PairAsk,
  secret: string,
  now: number,
  keyed: Keyed,
): { readonly ok: true; readonly pairs: Pairs; readonly answer: { readonly name: string; readonly secret: string } } | Refused => {
  const hash = keyed.hash(ask.code)
  const invite = pairs.invites.find((open) => open.expires > now && keyed.same(open.hash, hash))
  if (invite === undefined || pairs.name === undefined) return refused("the code is unknown, used or expired")
  if (!validName(ask.name)) return refused(`${JSON.stringify(ask.name)} is not a mail name`)
  if (ask.name === pairs.name) return refused(`${ask.name} is this host's own name`)
  return {
    ok: true,
    pairs: {
      ...pairs,
      peers: { ...pairs.peers, [ask.name]: { url: ask.url, secret, paired: now } },
      invites: pairs.invites.filter((open) => open !== invite && open.expires > now),
    },
    answer: { name: pairs.name, secret },
  }
}

/** The joiner keeps the inviter, under the name it answered, with the secret it gave, and its own name. */
export const joined = (pairs: Pairs, self: string, peer: { readonly name: string; readonly url: string; readonly secret: string }, now: number): Pairs => ({
  ...pairs,
  name: pairs.name ?? self,
  peers: { ...pairs.peers, [peer.name]: { url: peer.url, secret: peer.secret, paired: now } },
})

/** The headers a signed request carries. */
export const HEADERS = {
  peer: "x-mail-peer",
  time: "x-mail-time",
  nonce: "x-mail-nonce",
  signature: "x-mail-signature",
} as const

/** What a signature covers. */
export const payload = (request: { readonly method: string; readonly path: string; readonly time: string; readonly nonce: string; readonly body: string }): string =>
  [request.method.toUpperCase(), request.path, request.time, request.nonce, request.body].join("\n")

/** The headers `from` signs a request with, under the secret it shares with the receiver. */
export const sign = (
  from: string,
  secret: string,
  request: { readonly method: string; readonly path: string; readonly body: string },
  time: number,
  nonce: string,
  keyed: Keyed,
): Record<string, string> => ({
  [HEADERS.peer]: from,
  [HEADERS.time]: String(time),
  [HEADERS.nonce]: nonce,
  [HEADERS.signature]: keyed.mac(secret, payload({ ...request, time: String(time), nonce })),
})

/** A request as the listener read it. */
export interface Incoming {
  readonly method: string
  readonly path: string
  readonly body: string
  readonly header: (name: string) => string | undefined
}

/**
 * The paired host that sent `request`, or why it is refused: no such peer, a
 * time off by more than `SKEW_MS`, a nonce `seen` already, or a signature that
 * is not the peer's secret's.
 */
export const authenticate = (
  pairs: Pairs,
  request: Incoming,
  now: number,
  seen: (nonce: string) => boolean,
  keyed: Keyed,
): { readonly ok: true; readonly peer: string; readonly nonce: string } | Refused => {
  const name = request.header(HEADERS.peer)
  const time = request.header(HEADERS.time)
  const nonce = request.header(HEADERS.nonce)
  const signature = request.header(HEADERS.signature)
  if (name === undefined || time === undefined || nonce === undefined || signature === undefined) return refused("the request is not signed")
  const peer = Object.hasOwn(pairs.peers, name) ? pairs.peers[name] : undefined
  if (peer === undefined) return refused(`${JSON.stringify(name)} is not paired with this host`)
  const at = Number(time)
  if (!Number.isFinite(at) || Math.abs(now - at) > SKEW_MS) return refused(`the request's time is more than ${SKEW_MS / 1000}s off`)
  if (nonce.length < 16 || seen(nonce)) return refused("the request was replayed")
  const expected = keyed.mac(peer.secret, payload({ method: request.method, path: request.path, time, nonce, body: request.body }))
  if (!keyed.same(expected, signature)) return refused(`the signature is not ${name}'s`)
  return { ok: true, peer: name, nonce }
}

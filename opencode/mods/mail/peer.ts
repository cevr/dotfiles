// What paired hosts say to each other over the mail listener: its routes and
// their bodies. A host lists its sessions to a peer (`list`), takes a letter
// for one of its sessions (`receive`) and pairs (`pair`, the only route not
// signed). The listener binds one address, never a wildcard.
import { Schema } from "effect"

/** The listener's routes. */
export const ROUTES = {
  list: "/mail/v1/list",
  receive: "/mail/v1/receive",
  pair: "/mail/v1/pair",
} as const

/**
 * The listener's refusal of a request signed before it started (the nonces it saw died with the listener before it):
 * the sender signs it again, with a fresh nonce and time, up to `RESIGNS` times.
 */
export const SIGNED_BEFORE_START = "the request was signed before this listener started"

/** How many times a sender signs a request again after `SIGNED_BEFORE_START`. */
export const RESIGNS = 3

/** The port a mail listener uses unless configured. */
export const DEFAULT_PORT = 4196

/** An address that would listen on every interface. */
export const isWildcard = (hostname: string): boolean => ["", "0.0.0.0", "::", "[::]", "*", "0:0:0:0:0:0:0:0"].includes(hostname.trim())

/** The URL a listener on `hostname:port` answers at. */
export const urlOf = (hostname: string, port: number): string => `http://${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}:${port}`

/** A session as a peer lists it. */
export const Card = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  directory: Schema.String,
  agent: Schema.optional(Schema.String),
  running: Schema.Boolean,
  parentID: Schema.optional(Schema.String),
  updated: Schema.Number,
})
export const Cards = Schema.Array(Card)

export const ListAsk = Schema.Struct({ children: Schema.Boolean })

const Named = Schema.Struct({ id: Schema.String, title: Schema.String })

/** A letter for a session on the peer: whom it is for, who wrote, who answers, the text and whether to wake it. */
export const Parcel = Schema.Struct({
  /**
   * The parcel's id, the same on every try of one send: the peer holds a parcel once whatever number of times it
   * arrives. A sender older than it sends none, and its parcel is held each time it arrives.
   */
  id: Schema.optional(Schema.String),
  to: Schema.String,
  from: Named,
  replyTo: Named,
  body: Schema.String,
  wake: Schema.Boolean,
})
export type Parcel = typeof Parcel.Type

/** What the peer did with a parcel: delivered it, has no such session, or refused it. */
export const Arrival = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("delivered"), to: Card, delivery: Schema.Literals(["steered", "woke", "queued"]) }),
  Schema.Struct({ outcome: Schema.Literal("unknown") }),
  Schema.Struct({ outcome: Schema.Literal("refused"), message: Schema.String }),
])
export type Arrival = typeof Arrival.Type

/** The joiner's pairing request and the inviter's answer. */
export const PairAsk = Schema.Struct({ code: Schema.String, name: Schema.String, url: Schema.String })
export const PairAnswer = Schema.Struct({ name: Schema.String, secret: Schema.String })

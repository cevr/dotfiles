// One page over every host: each host's digest reads its named peers' views and shows their projects beside its own.
//
// - A peer is named in the config (`digest.peers`, scripts/daily.ts): its display name and its Tailscale host name.
//   It is looked up in Tailscale's own status (bind.ts `peerHostsOf`), never through DNS, and nothing the config
//   does not name is ever read or trusted. No discovery.
// - Read: GET `<peer>/peer/view.json` over the peer's tailnet listener (unit 4's: Tailscale's addresses, the Host
//   check), with what a tailnet member may read there. It answers the WIRE envelope, `{"wire":1,"host":…,"view":…}`:
//   the peer's own view only (never its peers'), so three hosts read each other directly and nothing is relayed.
// - The envelope is a wire format: versioned, additive only. A `wire` this build does not know, or a peer with no
//   such route (an older build, 404), is "needs update" and its view is never parsed loosely. A field added to the
//   view under the same wire is optional and ignored by an older reader.
// - A peer that is down, slow (PEER_TIMEOUT), or answers anything else is "down": its section says so with the time
//   last seen, and the local view is never held up or broken by it. Each peer is read once every PULL_EVERY, one
//   read at a time: no retry storm.
// - Ids: a peer's project, message and mark ids are qualified by the peer (`peer:<name>/<id>`), so two hosts'
//   `dotfiles` projects never meet.
// - Write: an item's unread, Later, pin, name and answer live on the host that owns it, and only there. A peer's
//   project in this view is read only: the page links to the owning host's page (its origin is in the view), whose
//   own policy decides the write. No host writes on another's behalf, and nothing here accepts a write for a peer.
import { Data, Duration, Match, Option, Schema } from "effect"
import { hostOf, type PeerHost } from "./bind.ts"
import { historyFrom, type PeerStatus, spansOf, View, ViewMessage, ViewProject } from "./view.ts"
import { when } from "./zone.ts"

/** The wire format's version this build reads and writes. */
export const WIRE = 1
/** How long one read of a peer may take. */
export const PEER_TIMEOUT = Duration.seconds(3)
/** How often each peer is read. */
export const PULL_EVERY = Duration.seconds(15)

/** A peer as the config names it: how the page shows it, and its Tailscale host name (MagicDNS's first label). */
export const NamedPeer = Schema.Struct({ name: Schema.NonEmptyString, host: Schema.NonEmptyString })
export type NamedPeer = typeof NamedPeer.Type

/** The wire envelope a peer answers at `/peer/view.json`. */
export const Envelope = Schema.Struct({ wire: Schema.Literal(WIRE), host: Schema.String, view: View })
const WireOnly = Schema.Struct({ wire: Schema.Number })
const decodeWire = Schema.decodeUnknownOption(Schema.fromJsonString(WireOnly))
const encodeEnvelope = Schema.encodeSync(Schema.fromJsonString(Envelope))

/**
 * The envelope as read: strict but for each message, which is read one by one so a message this build cannot read
 * (a kind it does not know, an agent's answer from a later build) is left out and the rest still shows.
 */
const ReadProject = Schema.Struct({ ...ViewProject.fields, inbox: Schema.Array(Schema.Unknown), later: Schema.Array(Schema.Unknown) })
const ReadEnvelope = Schema.Struct({ wire: Schema.Literal(WIRE), host: Schema.String, view: Schema.Struct({ ...View.fields, projects: Schema.Array(ReadProject) }) })
const decodeRead = Schema.decodeUnknownOption(Schema.fromJsonString(ReadEnvelope))
const decodeMessage = Schema.decodeUnknownOption(ViewMessage)

/** A read envelope's view, each message this build cannot read left out. */
const viewOfRead = (read: typeof ReadEnvelope.Type): View => ({
  ...read.view,
  projects: read.view.projects.map((project) => ({
    ...project,
    inbox: project.inbox.flatMap((message) => Option.toArray(decodeMessage(message))),
    later: project.later.flatMap((message) => Option.toArray(decodeMessage(message))),
  })),
})

/** This host's envelope: its own view, under its name. */
export const envelopeOf = (host: string, view: View): string => encodeEnvelope({ wire: WIRE, host, view })

/** Where a named peer is read, and where its page is: its first Tailscale address on the page's port. */
export interface Target {
  readonly name: string
  readonly base: string
}

/** Where `named` is, from the tailnet's devices: none when Tailscale lists no such device with an address. */
export const targetOf = (named: NamedPeer, hosts: ReadonlyArray<PeerHost>, port: number): Option.Option<Target> =>
  Option.flatMap(Option.fromUndefinedOr(hosts.find((each) => each.host === named.host.toLowerCase())), (peer) =>
    Option.map(Option.fromUndefinedOr(peer.ips[0]), (first) => ({ name: named.name, base: `http://${hostOf(first)}:${port}`})),
  )

/** What one read of a peer came to. */
export type Reading = Data.TaggedEnum<{
  Up: { readonly view: View }
  Down: { readonly reason: string }
  Update: { readonly reason: string }
}>
export const Reading = Data.taggedEnum<Reading>()

/** Why a peer that refuses the read is down: its policy does not let this host read it. */
export const NOT_ALLOWED = "this host is not allowed to read that one: it needs pairing or to be the same Tailscale user"

/** A peer's answer (`status`, `body`) as a reading: the envelope, a newer or older wire, or nothing usable. */
export const readingOf = (status: number, body: string): Reading =>
  Match.value(status).pipe(
    Match.when(404, () => Reading.Update({ reason: "peer needs update (it serves no peer view)" })),
    Match.when((each) => each === 401 || each === 403, () => Reading.Down({ reason: NOT_ALLOWED })),
    Match.when(200, () =>
      Option.match(decodeWire(body), {
        onNone: () => Reading.Down({ reason: "it answered something unreadable" }),
        onSome: ({ wire }) =>
          Option.match(Option.liftPredicate(wire, (each) => each === WIRE), {
            onNone: () => Reading.Update({ reason: `peer needs update (its wire is ${wire}, this build reads ${WIRE})` }),
            onSome: () =>
              Option.match(decodeRead(body), {
                onNone: () => Reading.Down({ reason: "it answered something unreadable" }),
                onSome: (read) => Reading.Up({ view: viewOfRead(read) }),
              }),
          }),
      }),
    ),
    Match.orElse(() => Reading.Down({ reason: `it answered ${status}` })),
  )

/** A named peer as this host knows it: where it is, its last reading, and when it was last read well. */
export interface Peer {
  readonly name: string
  readonly origin: Option.Option<string>
  readonly reading: Reading
  readonly lastSeen: Option.Option<number>
}

/** A named peer never read yet. */
export const unread = (name: string): Peer => ({ name, origin: Option.none(), reading: Reading.Down({ reason: "not read yet" }), lastSeen: Option.none() })

/** `peer` after a reading at `at` from `origin`. */
export const afterReading = (peer: Peer, reading: Reading, origin: Option.Option<string>, at: number): Peer => ({
  name: peer.name,
  origin: Option.orElse(origin, () => peer.origin),
  reading,
  lastSeen: Option.orElse(
    Option.map(Option.liftPredicate(reading, (each) => each._tag === "Up"), () => at),
    () => peer.lastSeen,
  ),
})

/** How the page shows a peer. */
const statusOf = (peer: Peer, now: number, zone: string): PeerStatus => ({
  name: peer.name,
  state: Match.valueTags(peer.reading, { Up: () => "up" as const, Down: () => "down" as const, Update: () => "update" as const }),
  reason: Match.valueTags(peer.reading, { Up: () => "", Down: ({ reason }) => reason, Update: ({ reason }) => reason }),
  lastSeen: peer.lastSeen,
  lastSeenLabel: Option.map(peer.lastSeen, (t) => when(t, now, zone)),
  origin: peer.origin,
})

/** An id of `peer`'s in the merged view: two hosts may each have a `dotfiles` project or an `install` message. */
export const peerId = (peer: string, id: string): string => `peer:${peer}/${id}`

/** A peer's project in the merged view: its ids qualified by the peer, labelled with it and where it is written. */
const qualified = (project: ViewProject, peer: Peer): ViewProject => ({
  ...project,
  id: peerId(peer.name, project.id),
  inbox: project.inbox.map((message) => ({ ...message, id: peerId(peer.name, message.id) })),
  later: project.later.map((message) => ({ ...message, id: peerId(peer.name, message.id) })),
  marks: project.marks.map((mark) => ({ ...mark, id: peerId(peer.name, mark.id) })),
  host: Option.some(peer.name),
  origin: peer.origin,
})

/** Whether a peer is up: its projects are shown. */
export const upCount = (peers: ReadonlyArray<Peer>): number => peers.filter((each) => each.reading._tag === "Up").length

/**
 * The page's view over every host: this host's own projects (named `self`), then each up peer's, each labelled with
 * its host and (a peer's) the origin it is written at; every peer's status; the timeline over them all. A peer that
 * is not up adds no project, only its status.
 */
export const mergeView = (local: View, self: string, peers: ReadonlyArray<Peer>): View => {
  const own = local.projects.map((project): ViewProject => ({ ...project, host: Option.some(self), origin: Option.none() }))
  const theirs = peers.flatMap((peer) =>
    Match.valueTags(peer.reading, {
      Up: ({ view }) => view.projects.map((project) => qualified(project, peer)),
      Down: (): ReadonlyArray<ViewProject> => [],
      Update: (): ReadonlyArray<ViewProject> => [],
    }),
  )
  const projects = [...own, ...theirs]
  return {
    ...local,
    projects,
    spans: spansOf(historyFrom(projects, local.now, local.zone), local.now, local.zone),
    host: Option.some(self),
    peers: Option.some(peers.map((peer) => statusOf(peer, local.now, local.zone))),
  }
}

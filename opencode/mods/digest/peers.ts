// One page over every host: each host's digest reads its named peers' views and shows their projects beside its own.
//
// - A peer is named in the config (`digest.peers`, scripts/daily.ts): its display name and its host name, which is
//   also one of `digest.agentHosts`. It is found as the device the device store keys for that name (`keyedOf`: by
//   stable ID, in Tailscale's own status, never by a name lookup nor DNS), and nothing the config does not name and
//   the store does not key is ever read or trusted. No discovery.
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
import { Array as Arr, Data, Duration, Match, Option, Order, Schema } from "effect"
import { canonicalOf, hostOf, isTailnet, type PeerStatus as TailnetPeer, StatusRead } from "./bind.ts"
import { nameKey } from "./devices.ts"
import { type AgentKey, carriesName, type Exclusion, hisDevices, MEMBERS_TTL } from "./members.ts"
import { historyFrom, type PeerStatus, spansOf, View, ViewMessage, ViewProject } from "./view.ts"
import { when } from "./zone.ts"

/**
 * What a named peer is found by: one Tailscale status read, the device store's agent keys and exclusions as read
 * with it (devices.ts keysOf), and when. The plugin keeps the latest beside his devices (cmd/digest/server.ts
 * `probeKeeping`).
 */
export interface Sighting {
  readonly read: StatusRead
  readonly agents: ReadonlyArray<AgentKey>
  readonly excluded: ReadonlyArray<Exclusion>
  readonly at: number
}

/** Nothing read yet: no peer is anywhere. */
export const UNSEEN: Sighting = { read: StatusRead.Unread({ why: "starting" }), agents: [], excluded: [], at: 0 }

/** A named peer's device now: its addresses in the tailnet's ranges (IPv4 first) and its MagicDNS name, if a plain one. */
export interface Keyed {
  readonly ips: ReadonlyArray<string>
  readonly dnsName: Option.Option<string>
}

const IPV4_FIRST: Order.Order<string> = Order.combine(Order.mapInput(Order.Number, (address: string) => Number(address.includes(":"))), Order.String)

/** A MagicDNS name as an origin may carry it: lower case labels of letters, digits and inner dashes, no trailing dot. */
const PLAIN_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * The device the store keys for the peer named `host`, as `sighting` saw it, if it is current at `now`. Never a name
 * lookup (owner via the orchestrator, 2026-11-22: a name resolved to a device for a security decision failed three
 * rounds running): the device is the one, and only, device of his (same UserID, untagged, not shared in) that carries
 * a stable ID the store holds for that name as an agent host, and no excluded one. None (closed) when the store keys
 * no ID for it, no device or two carry one, the status did not read, Tailscale is not running, or the read is older
 * than MEMBERS_TTL. Its addresses are those it alone lists: one another device lists too is nobody's.
 */
export const keyedOf = (host: string, sighting: Sighting, now: number): Option.Option<Keyed> => {
  const ids = sighting.agents.filter((agent) => nameKey(agent.name) === nameKey(host)).flatMap((agent) => agent.ids)
  const excludedIds = sighting.excluded.flatMap((exclusion) => exclusion.ids)
  const fresh = sighting.at > 0 && now - sighting.at <= Duration.toMillis(MEMBERS_TTL)
  return Match.valueTags(sighting.read, {
    Unread: () => Option.none(),
    Read: ({ status }) => {
      if (!fresh || status.backendState !== "Running" || ids.length === 0) return Option.none()
      const carries = (peer: TailnetPeer) => Option.exists(peer.stableId, (id) => ids.includes(id) && !excludedIds.includes(id))
      const excludedByName = (peer: TailnetPeer) => sighting.excluded.some((exclusion) => carriesName(exclusion.name, peer))
      const found = hisDevices(status).filter((peer) => carries(peer) && !excludedByName(peer))
      return Option.flatMap(
        Option.filter(Arr.head(found), () => found.length === 1),
        (device) => {
          const elsewhere = new Set([...status.ips, ...status.peers.filter((peer) => peer !== device).flatMap((peer) => peer.ips)].flatMap((ip) => Option.toArray(canonicalOf(ip))))
          // As Tailscale spells them (RFC 5952, as a browser spells an origin), compared in one spelling.
          const ips = Arr.sort([...new Set(device.ips.map((ip) => ip.toLowerCase()).filter((ip) => Option.exists(canonicalOf(ip), (one) => isTailnet(one) && !elsewhere.has(one))))], IPV4_FIRST)
          const dnsName = Option.filter(Option.map(device.dnsName, (name) => name.toLowerCase().replace(/\.$/, "")), (name) => PLAIN_NAME.test(name))
          return Option.liftPredicate({ ips, dnsName }, (each) => each.ips.length > 0)
        },
      )
    },
  })
}

/** Where each of `named` is read now, by name: its keyed device's first address on `port` (keyedOf). */
export const locateIn = (named: ReadonlyArray<NamedPeer>, sighting: Sighting, now: number, port: number): ReadonlyMap<string, Target> =>
  new Map(named.flatMap((each) => Option.toArray(keyedOf(each.host, sighting, now)).flatMap((keyed) => Option.toArray(targetOf(each, keyed, port)).map((target): readonly [string, Target] => [each.name, target]))))

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

/** Where `named` is read, its keyed device being `keyed`: its first address on `port`. */
export const targetOf = (named: NamedPeer, keyed: Keyed, port: number): Option.Option<Target> =>
  Option.map(Arr.head(keyed.ips), (first) => ({ name: named.name, base: `http://${hostOf(first)}:${port}` }))

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

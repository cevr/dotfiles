// His devices on the tailnet, as the page's policy needs them: which addresses are his own devices, and which of
// those are agent machines, read from Tailscale's status (`tailscale status --json`, process/tailnet.ts) and never
// from DNS or a request's headers.
//
// - His (`own`): this host and each device whose `UserID` is this host's own. His tailnet holds other people's
//   devices too (a work tailnet), so being on the tailnet is never enough. A tagged device (its UserID names no
//   person), a device shared in from another tailnet, and every device when this host is itself tagged or has no
//   UserID, are not his. An address that another device lists too is not his either.
// - Agents (`agent`): this host, and those of HIS devices that `digest.agentHosts` names, each by its MagicDNS name
//   (the coordination server assigns it and keeps it unique in the tailnet), that name's first label, or one of its
//   addresses. Never by HostName, which a device chooses for itself, and never among other users' devices. Being an
//   agent host only ever restricts: an agent is one of his devices that may read (under tailnetRead "member") but
//   not write without a token (under tailnetWrite "member-except-hosts"). It never admits a device that is not his.
// - Excluded (`digest.excludedDevices`): his devices that count as nobody's, reading and writing nothing unpaired,
//   as another user's device. Each exclusion carries the device's MagicDNS name and its stable node ID (the status's
//   `ID`: the coordination server assigns it, and a rename or a new HostName does not change it); a device either
//   matches is excluded, so taking out more only restricts. The installer keeps every ID it shipped, so a rename never
//   unkeys one (`exclusionsFrom`). An exclusion with no ID (unkeyed) cannot be applied, so it closes every tailnet
//   source to "paired", reads and writes, until it has one (health: `paired:unkeyed:<name>`). One whose IDs no device
//   of his has is a device gone (removed from his tailnet): harmless, access unchanged, health notes `unmatched:`.
// - Under `digest.tailnetWrite: "member-except-hosts"`, an entry none of his devices answers to closes the writes to
//   "paired" (fail closed), and the health line says which name, whatever other users' devices call themselves.
// - The entries are resolved at each status read, so a renamed or re-keyed device leaves no stale address behind.
// - Freshness: the status is read again every RECHECK (30 s); a read that fails, or Tailscale not running, closes
//   everything to "paired" at once; members older than MEMBERS_TTL are treated as closed too, so a device removed
//   from his account stops being his within a recheck, and never later than MEMBERS_TTL.
import { Duration, Match, Option } from "effect"
import { canonicalOf, isTailnet, type PeerStatus, type StatusRead, type TailscaleStatus } from "./bind.ts"
import type { Source, TailnetWrite } from "./policy.ts"

/** How old the members may be before they count for nothing. */
export const MEMBERS_TTL = Duration.seconds(75)

/**
 * One of his devices to treat as nobody's (`digest.excludedDevices`): its MagicDNS name, and every Tailscale stable
 * node ID (`ID` in the status) it has had, which the device cannot change, resolved among his devices when the tree
 * is configured and kept from one configure to the next (`exclusionsFrom`). With no ID yet it is unkeyed.
 */
export interface Exclusion {
  readonly name: string
  readonly ids: ReadonlyArray<string>
}

/** `digest.tailnetWrite`, `digest.agentHosts` and `digest.excludedDevices`, as configured. */
export interface WriteConfig {
  readonly tailnetWrite: TailnetWrite
  readonly agentHosts: ReadonlyArray<string>
  readonly excluded: ReadonlyArray<Exclusion>
}

/** His devices now, with the write switch as in force. */
export interface Members {
  /** `digest.tailnetWrite` in force: "paired" when it closed. */
  readonly write: TailnetWrite
  /** Why it closed to "paired" (`unresolved:<name>`, `status:<why>`, `not-running`, `stale`); empty when it did not. */
  readonly why: string
  /** The agent machines' addresses (this host's and the named agent hosts'), each in one spelling; all his. */
  readonly agents: ReadonlyArray<string>
  /** His other devices' addresses, each in one spelling. */
  readonly own: ReadonlyArray<string>
  /** How many of his other devices the status names (health's `members=`, on loopback only). */
  readonly devices: number
  /** How many of those are no agent host, so may write as him without a token (health's `writers=`). */
  readonly writers: number
  /**
   * The exclusions as health names them (`excluded=`): how many of his devices are excluded, then
   * `:unmatched:<name>` for an exclusion none of whose IDs a device of his has (an unkeyed one closes instead).
   */
  readonly excluded: string
  /** When the status was read. */
  readonly at: number
}

/** No devices at all, for `why`: every tailnet source needs the token. */
export const closed = (why: string, at = 0): Members => ({ write: "paired", why, agents: [], own: [], devices: 0, writers: 0, excluded: "0", at })

/** A word for a reason: letters, digits, dots and dashes only. */
const word = (text: string) => text.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 60)

/** The addresses, each in one spelling, those in Tailscale's ranges only. */
const spelled = (ips: ReadonlyArray<string>): ReadonlyArray<string> => ips.flatMap((ip) => Option.toArray(Option.filter(canonicalOf(ip), isTailnet)))

/** One device as membership reads it: its MagicDNS name and its addresses in one spelling. */
interface Node {
  readonly dnsName: Option.Option<string>
  readonly ips: ReadonlyArray<string>
}

/** Whether `node` answers to the agent-host entry: its MagicDNS name, that name's first label, or one of its addresses. */
const answersTo = (entry: string, node: Node): boolean =>
  Option.match(canonicalOf(entry), {
    onSome: (address) => node.ips.includes(address),
    onNone: () => {
      const wanted = entry.toLowerCase().replace(/\.$/, "")
      const dns = Option.getOrElse(Option.map(node.dnsName, (each) => each.toLowerCase()), () => "")
      return wanted !== "" && dns !== "" && (wanted === dns || wanted === (dns.split(".")[0] ?? ""))
    },
  })

/** Whether this host is a person's: it has a UserID and no tags. */
const selfIsHis = (status: TailscaleStatus): boolean => !status.tagged && Option.isSome(status.userId)

/** Whether a peer is a device of this host's own user: same UserID, not tagged, not shared in. */
const isOwn = (status: TailscaleStatus, peer: PeerStatus): boolean =>
  selfIsHis(status) && !peer.tagged && !peer.shared && Option.getOrElse(Option.zipWith(status.userId, peer.userId, (mine, theirs) => mine === theirs), () => false)

/** Whether `peer` carries one of the exclusion's stable IDs. */
const keyedTo = (exclusion: Exclusion, peer: PeerStatus): boolean => exclusion.ids.some((id) => Option.contains(peer.stableId, id))

/** Whether an exclusion takes `peer`: by one of its stable IDs, or by its MagicDNS name (either: excluding more only restricts). */
const excludes = (exclusion: Exclusion, peer: PeerStatus): boolean => keyedTo(exclusion, peer) || answersTo(exclusion.name, { dnsName: peer.dnsName, ips: [] })

/** Health's `excluded=` word: the count, and each exclusion none of whose IDs a device of his has (a device gone: harmless). */
const exclusionsWord = (exclusions: ReadonlyArray<Exclusion>, his: ReadonlyArray<PeerStatus>, count: number): string =>
  [`${count}`, ...exclusions.flatMap((exclusion) => [`unmatched:${word(exclusion.name)}`].filter(() => !his.some((peer) => keyedTo(exclusion, peer))))].join(":")

/** His devices from a status read at `at`, under `config`. */
export const membersOf = (config: WriteConfig, read: StatusRead, at: number): Members =>
  Match.valueTags(read, {
    Unread: ({ why }) => closed(`status:${word(why)}`, at),
    Read: ({ status }) => {
      if (status.backendState !== "Running") return closed("not-running", at)
      // An exclusion with no stable ID cannot be applied whatever the device is called: everything closes until it has one.
      const unkeyed = Option.fromUndefinedOr(config.excluded.find((exclusion) => exclusion.ids.length === 0))
      if (Option.isSome(unkeyed)) return closed(`unkeyed:${word(unkeyed.value.name)}`, at)
      // An excluded device of his is nobody's, like another user's: its addresses count as theirs.
      const ownPeers = status.peers.filter((peer) => isOwn(status, peer))
      const isExcluded = (peer: PeerStatus) => config.excluded.some((exclusion) => excludes(exclusion, peer))
      const counted = ownPeers.filter((peer) => !isExcluded(peer))
      // An address another device lists too is contested: nobody's.
      const theirs = new Set(spelled(status.peers.filter((peer) => !counted.includes(peer)).flatMap((peer) => peer.ips)))
      const mine = (ips: ReadonlyArray<string>) => spelled(ips).filter((ip) => !theirs.has(ip))
      const self: Node = { dnsName: status.dnsName, ips: mine(status.ips).filter(() => selfIsHis(status)) }
      const peers = counted.map((peer): Node => ({ dnsName: peer.dnsName, ips: mine(peer.ips) }))
      const named = (node: Node) => config.agentHosts.some((entry) => answersTo(entry, node))
      const agents = [...new Set([...self.ips, ...peers.filter(named).flatMap((node) => node.ips)])]
      const own = [...new Set(peers.flatMap((node) => node.ips))].filter((ip) => !agents.includes(ip))
      // Resolved among his devices only: this host when it is his, and his peers.
      const his = [...[self].filter(() => selfIsHis(status)), ...peers]
      const unresolved = Option.fromUndefinedOr(config.agentHosts.find((entry) => !his.some((node) => answersTo(entry, node))))
      const found = { agents, own, devices: peers.length, excluded: exclusionsWord(config.excluded, ownPeers, ownPeers.length - counted.length), at }
      // Who writes as him with no token under each switch: nobody, all his other devices, or those no agent host.
      const writers = { paired: 0, member: peers.length, "member-except-hosts": peers.filter((node) => !named(node)).length } satisfies Record<TailnetWrite, number>
      return Option.match(Option.filter(unresolved, () => config.tailnetWrite === "member-except-hosts"), {
        onSome: (missing): Members => ({ ...found, writers: 0, write: "paired", why: `unresolved:${word(missing)}` }),
        onNone: (): Members => ({ ...found, writers: writers[config.tailnetWrite], write: config.tailnetWrite, why: "" }),
      })
    },
  })

/**
 * `digest.excludedDevices` for the installer, from what it shipped before (`previous`) and the status now: each name
 * keeps every stable ID it ever had, and adds the ID of the device of HIS that carries the name as its MagicDNS name
 * (or first label) now. An ID is never dropped, so a rename, a status that cannot be read, or another user's device
 * taking the name never unkeys an exclusion; a name with no ID yet (first configure, no status) ships unkeyed, which
 * closes the tailnet to "paired" until it has one.
 */
export const exclusionsFrom = (previous: ReadonlyArray<Exclusion>, names: ReadonlyArray<string>, read: StatusRead): ReadonlyArray<Exclusion> =>
  names.map((name) => {
    const his = Match.valueTags(read, { Read: ({ status }) => status.peers.filter((peer) => status.backendState === "Running" && isOwn(status, peer)), Unread: (): ReadonlyArray<PeerStatus> => [] })
    const now = his.filter((peer) => answersTo(name, { dnsName: peer.dnsName, ips: [] })).flatMap((peer) => Option.toArray(peer.stableId))
    const before = previous.filter((each) => each.name === name).flatMap((each) => each.ids)
    return { name, ids: [...new Set([...before, ...now])] }
  })

/** The members as they count at `now`: closed once older than MEMBERS_TTL. */
export const current = (members: Members, now: number): Members =>
  Option.getOrElse(Option.liftPredicate(members, (each) => now - each.at <= Duration.toMillis(MEMBERS_TTL)), () => closed("stale", members.at))

/** Who `address` (a socket's peer address on the tailnet listener) is. */
export const sourceOf = (address: string, members: Members): Source =>
  Option.match(Option.filter(canonicalOf(address), isTailnet), {
    onNone: (): Source => "outside",
    onSome: (spelling): Source =>
      Match.value(spelling).pipe(
        Match.when((each) => members.agents.includes(each), (): Source => "agent"),
        Match.when((each) => members.own.includes(each), (): Source => "own"),
        Match.orElse((): Source => "other"),
      ),
  })

/** The write switch as health names it: in force, and why it closed. */
export const writesWord = (members: Members): string => [members.write, ...Option.toArray(Option.liftPredicate(members.why, (why) => why !== ""))].join(":")

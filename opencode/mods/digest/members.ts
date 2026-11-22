// His devices on the tailnet, as the page's policy needs them: which addresses are his own devices, and which are
// agent machines, read from Tailscale's status (`tailscale status --json`, process/tailnet.ts) and never from DNS
// or a request's headers.
//
// - Own (`own`): a device whose `UserID` is this host's own. His tailnet holds other people's devices too (a work
//   tailnet), so being on the tailnet is never enough. A tagged device (its UserID names no person), a device shared
//   in from another tailnet, and every device when this host is itself tagged or has no UserID, are not his own.
// - Agents (`agent`): this host's own Tailscale addresses, and those of `digest.agentHosts`, each an address or a
//   name the status gives (a MagicDNS name, its first label, or the device's HostName). Under
//   `digest.tailnetWrite: "member-except-hosts"` a name the status does not resolve closes the writes to "paired"
//   (fail closed), and the health line says which name.
// - Freshness: the status is read again every RECHECK (30 s); a read that fails, or Tailscale not running, closes
//   everything to "paired" at once; members older than MEMBERS_TTL are treated as closed too, so a device removed
//   from his account stops being his within a recheck, and never later than MEMBERS_TTL.
import { Duration, Match, Option } from "effect"
import { canonicalOf, isTailnet, type PeerStatus, type StatusRead, type TailscaleStatus } from "./bind.ts"
import type { Source, TailnetWrite } from "./policy.ts"

/** How old the members may be before they count for nothing. */
export const MEMBERS_TTL = Duration.seconds(75)

/** `digest.tailnetWrite` and `digest.agentHosts`, as configured. */
export interface WriteConfig {
  readonly tailnetWrite: TailnetWrite
  readonly agentHosts: ReadonlyArray<string>
}

/** His devices now, with the write switch as in force. */
export interface Members {
  /** `digest.tailnetWrite` in force: "paired" when it closed. */
  readonly write: TailnetWrite
  /** Why it closed to "paired" (`unresolved:<name>`, `status:<why>`, `not-running`, `stale`); empty when it did not. */
  readonly why: string
  /** This host's and the agent hosts' addresses, each in one spelling (bind.ts `canonicalOf`). */
  readonly agents: ReadonlyArray<string>
  /** His other devices' addresses, each in one spelling. */
  readonly own: ReadonlyArray<string>
  /** How many of his other devices the status names (health's `members=`, on loopback only). */
  readonly devices: number
  /** When the status was read. */
  readonly at: number
}

/** No devices at all, for `why`: every tailnet source needs the token. */
export const closed = (why: string, at = 0): Members => ({ write: "paired", why, agents: [], own: [], devices: 0, at })

/** A word for a reason: letters, digits, dots and dashes only. */
const word = (text: string) => text.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 60)

/** The addresses, each in one spelling, those in Tailscale's ranges only. */
const spelled = (ips: ReadonlyArray<string>): ReadonlyArray<string> => ips.flatMap((ip) => Option.toArray(Option.filter(canonicalOf(ip), isTailnet)))

/** Whether `node` answers to `name`: its MagicDNS name, that name's first label, or its HostName, in any case. */
const answersTo = (name: string, node: { readonly dnsName: Option.Option<string>; readonly hostName: string }): boolean => {
  const wanted = name.toLowerCase().replace(/\.$/, "")
  const dns = Option.getOrElse(Option.map(node.dnsName, (each) => each.toLowerCase()), () => "")
  return wanted !== "" && (wanted === dns || wanted === (dns.split(".")[0] ?? "") || wanted === node.hostName.toLowerCase())
}

/** The Tailscale addresses an agent host entry names: itself if an address in the ranges, else the devices of that name. */
export const resolveHost = (entry: string, status: TailscaleStatus): ReadonlyArray<string> =>
  Option.match(canonicalOf(entry), {
    onSome: (address) => Option.toArray(Option.liftPredicate(address, isTailnet)),
    onNone: () => spelled([{ dnsName: status.dnsName, hostName: "", ips: status.ips }, ...status.peers].filter((node) => answersTo(entry, node)).flatMap((node) => node.ips)),
  })

/**
 * Agent hosts as the installer writes them into `digest.agentHosts`: each of `names` as the Tailscale addresses
 * `read` gives it, or the name itself when the status does not resolve it (no status, not running, no such device),
 * for the plugin to resolve at each tailnet read or to close the writes on.
 */
export const agentHostsFrom = (names: ReadonlyArray<string>, read: StatusRead): ReadonlyArray<string> =>
  names.flatMap((name) => {
    const ips = Match.valueTags(read, { Read: ({ status }) => resolveHost(name, status).filter(() => status.backendState === "Running"), Unread: (): ReadonlyArray<string> => [] })
    return [...ips, ...[name].filter(() => ips.length === 0)]
  })

/** Whether a peer is a device of this host's own user: same UserID, not tagged, not shared in. */
const isOwn = (status: TailscaleStatus, peer: PeerStatus): boolean =>
  !status.tagged && !peer.tagged && !peer.shared && Option.getOrElse(Option.zipWith(status.userId, peer.userId, (mine, theirs) => mine === theirs), () => false)

/** His devices from a status read at `at`, under `config`. */
export const membersOf = (config: WriteConfig, read: StatusRead, at: number): Members =>
  Match.valueTags(read, {
    Unread: ({ why }) => closed(`status:${word(why)}`, at),
    Read: ({ status }) => {
      if (status.backendState !== "Running") return closed("not-running", at)
      const resolved = config.agentHosts.map((entry) => ({ entry, ips: resolveHost(entry, status) }))
      const agents = [...new Set([...spelled(status.ips), ...resolved.flatMap((each) => each.ips)])]
      const mine = status.peers.filter((peer) => isOwn(status, peer))
      const own = [...new Set(spelled(mine.flatMap((peer) => peer.ips)))].filter((ip) => !agents.includes(ip))
      const unresolved = Option.fromUndefinedOr(resolved.find((each) => each.ips.length === 0))
      const found = { agents, own, devices: mine.length, at }
      return Option.match(Option.filter(unresolved, () => config.tailnetWrite === "member-except-hosts"), {
        onSome: (missing): Members => ({ ...found, write: "paired", why: `unresolved:${word(missing.entry)}` }),
        onNone: (): Members => ({ ...found, write: config.tailnetWrite, why: "" }),
      })
    },
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

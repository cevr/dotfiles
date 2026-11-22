// Where the digest page may listen: loopback, and the host's own tailnet addresses. Nothing else, in code: a bind on
// any other address (a wildcard, a LAN address, a public one) is refused before a socket is made (`bindable`).
//
// - Loopback: 127.0.0.0/8 and ::1.
// - The tailnet: Tailscale's ranges, 100.64.0.0/10 (IPv4, shared CGNAT space) and fd7a:115c:a1e0::/48 (IPv6).
// - The host's tailnet addresses (`tailnetOf`) are those Tailscale's own status names (`Self.TailscaleIPs`) that are
//   also on one of the host's interfaces and inside those ranges: all three. 100.64.0.0/10 is shared CGNAT space
//   (Cloudflare WARP, a carrier hotspot, a corporate VPN number interfaces in it too), so being in the range is never
//   enough. No status (no CLI, a failed or timed-out one, output that does not parse) or Tailscale not Running: no
//   tailnet, loopback only, with the reason (health's `tailnet=no:<why>`). Read at the plugin's start and again every
//   recheck, so a Tailscale that goes down, comes up or moves is followed.
// - The listener's own names: each address, and the MagicDNS name and short host name from the same status. A
//   request naming any other host is refused (DNS rebinding), on every route.
import { Array as Arr, Data, Match, Option, Order } from "effect"

/** Why an address may not be bound. */
export class BindRefused extends Data.TaggedError("BindRefused")<{ readonly address: string; readonly message: string }> {}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** An IPv4 address's four octets; none for anything that is not one plainly. */
const octetsOf = (address: string): Option.Option<readonly [number, number, number, number]> =>
  Option.flatMap(Option.fromNullishOr(IPV4.exec(address)), (match) => {
    const octets = [match[1], match[2], match[3], match[4]].map(Number)
    const [a = -1, b = -1, c = -1, d = -1] = octets
    return Option.liftPredicate([a, b, c, d] as const, () => octets.every((each) => each >= 0 && each <= 255))
  })

/**
 * An IPv6 address's eight 16-bit groups (`::` expanded, an embedded IPv4 tail read too); none for anything that is
 * not one plainly. A zone (`%en0`) is not one: no zoned address is ours to bind.
 */
export const groupsOf = (address: string): Option.Option<ReadonlyArray<number>> => {
  if (!/^[0-9A-Fa-f:.]+$/.test(address)) return Option.none()
  // An embedded IPv4 tail (::ffff:127.0.0.1) is two groups.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
  const text = Option.match(Option.fromNullishOr(tail), {
    onNone: () => Option.some(address),
    onSome: (match) => Option.map(octetsOf(match[2] ?? ""), ([a, b, c, d]) => `${match[1] ?? ""}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`),
  })
  return Option.flatMap(text, (plain) => {
    const halves = plain.split("::")
    const parts = (side: string) => side.split(":").filter((each) => each !== "")
    const left = parts(halves[0] ?? "")
    const right = parts(halves[1] ?? "")
    const compressed = halves.length === 2
    const fill = 8 - left.length - right.length
    const groups = [...left, ...Array.from({ length: Math.max(fill, 0) }, () => "0"), ...right]
    const valid = halves.length <= 2 && halves.every((side) => !side.startsWith(":") && !side.endsWith(":")) && ((compressed && fill >= 1) || (!compressed && fill === 0)) && groups.every((each) => /^[0-9A-Fa-f]{1,4}$/.test(each))
    return Option.liftPredicate(
      groups.map((each) => Number.parseInt(each, 16)),
      () => valid,
    )
  })
}

/** Whether `address` is a loopback address: 127.0.0.0/8 or ::1. */
export const isLoopback = (address: string): boolean =>
  Option.match(octetsOf(address), {
    onSome: ([a]) => a === 127,
    onNone: () => Option.exists(groupsOf(address), (groups) => groups.slice(0, 7).every((each) => each === 0) && groups[7] === 1),
  })

/** Whether `address` is in Tailscale's ranges: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export const isTailnet = (address: string): boolean =>
  Option.match(octetsOf(address), {
    onSome: ([a, b]) => a === 100 && b >= 64 && b <= 127,
    onNone: () => Option.exists(groupsOf(address), ([a, b, c]) => a === 0xfd7a && b === 0x115c && c === 0xa1e0),
  })

/** The address, if the page may listen on it; why not otherwise. Wildcards, LAN and public addresses never may. */
export const bindable = (address: string): Option.Option<BindRefused> => {
  if (isLoopback(address) || isTailnet(address)) return Option.none()
  return Option.some(new BindRefused({ address, message: `the digest page listens on loopback and the tailnet only, never on "${address}"` }))
}

/** An interface address as `os.networkInterfaces()` lists it. */
export interface InterfaceAddress {
  readonly address: string
  readonly family: string
  readonly internal: boolean
}

/** What Tailscale's status says of this host: its backend state, its MagicDNS name, and its own addresses. */
export interface TailscaleStatus {
  /** `Running` when it serves; anything else (`Stopped`, `NeedsLogin`, `Starting`) is no tailnet. */
  readonly backendState: string
  /** `host.tailnet.ts.net`, without the trailing dot; none when MagicDNS is off. */
  readonly dnsName: Option.Option<string>
  /** `Self.TailscaleIPs`: the only addresses that are this host's on the tailnet. */
  readonly ips: ReadonlyArray<string>
  /** `Self.UserID`: the Tailscale user this host belongs to; none when the status has none. */
  readonly userId: Option.Option<number>
  /** Whether this host is a tagged device (`Self.Tags`): its UserID then names no person. */
  readonly tagged: boolean
  /** The other devices the status lists (`Peer`). */
  readonly peers: ReadonlyArray<PeerStatus>
}

/** Another device on the tailnet, as Tailscale's status lists it. */
export interface PeerStatus {
  /** Its MagicDNS name, without the trailing dot; none when MagicDNS is off. */
  readonly dnsName: Option.Option<string>
  /** `HostName`: the name the device gives itself. */
  readonly hostName: string
  /** `TailscaleIPs`. */
  readonly ips: ReadonlyArray<string>
  /** `UserID`: the Tailscale user it belongs to. */
  readonly userId: Option.Option<number>
  /** Whether it is a tagged device (`Tags`): its UserID then names no person. */
  readonly tagged: boolean
  /** Whether it is shared in from another tailnet (`ShareeNode`). */
  readonly shared: boolean
}

/** The CLI's status, or why there is none: `no-cli`, `cli-failed`, `cli-timeout`, `unparseable`. */
export type StatusRead = Data.TaggedEnum<{
  Read: { readonly status: TailscaleStatus }
  Unread: { readonly why: string }
}>
export const StatusRead = Data.taggedEnum<StatusRead>()

/** This host on the tailnet, as the page's second listener needs it: its addresses there, its names, and why none. */
export interface Tailnet {
  readonly addresses: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
  /** Why there is no tailnet address (health's `tailnet=no:<why>`); empty when there is one. */
  readonly why: string
}

/** No tailnet, for `why`. */
export const noTailnet = (why: string): Tailnet => ({ addresses: [], names: [], why })

/** Addresses as the listeners are made: IPv4 before IPv6, then by code units. */
const ADDRESS_ORDER: Order.Order<string> = Order.combine(Order.mapInput(Order.Number, (address: string) => Number(address.includes(":"))), Order.String)

/** Whether two addresses are one, however each is written (an IPv6 one compressed or not, upper or lower case). */
const sameAddress = (a: string, b: string): boolean =>
  a === b || Option.getOrElse(Option.zipWith(groupsOf(a), groupsOf(b), (x, y) => x.every((each, index) => each === y[index])), () => false)

/**
 * An address in one spelling, so two spellings of one address compare equal: IPv4 as dotted octets, an IPv4-mapped
 * IPv6 one (`::ffff:100.64.0.1`, `::ffff:6440:1`) as its IPv4 address, any other IPv6 one as eight lower-case groups
 * in full. None for anything that is not an address plainly (a name, a zoned address, brackets).
 */
export const canonicalOf = (address: string): Option.Option<string> =>
  Option.match(octetsOf(address), {
    onSome: (octets) => Option.some(octets.join(".")),
    onNone: () =>
      Option.map(groupsOf(address), (groups) =>
        Option.match(
          Option.liftPredicate(groups, (each) => each.slice(0, 5).every((group) => group === 0) && each[5] === 0xffff),
          {
            onSome: (mapped) => [(mapped[6] ?? 0) >> 8, (mapped[6] ?? 0) & 0xff, (mapped[7] ?? 0) >> 8, (mapped[7] ?? 0) & 0xff].join("."),
            onNone: () => groups.map((group) => group.toString(16)).join(":"),
          },
        ),
      ),
  })

/** A backend state as a reason's word: letters, digits and dashes only. */
const word = (text: string) => text.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)

/**
 * The host on the tailnet: each non-internal interface address that Tailscale's status names in `Self.TailscaleIPs`
 * and that is in the tailnet's ranges (IPv4 first, as the interface writes it). Its names are the MagicDNS name and
 * its first label. No status, a status that is not Running, or no such address: no tailnet, with the reason.
 */
export const tailnetOf = (interfaces: ReadonlyArray<InterfaceAddress>, read: StatusRead): Tailnet =>
  Match.valueTags(read, {
    Unread: ({ why }) => noTailnet(why),
    Read: ({ status }) => {
      if (status.backendState !== "Running") return noTailnet(`not-running:${word(status.backendState)}`)
      const found = interfaces.flatMap((each) =>
        Option.toArray(Option.liftPredicate(each.address, (address) => !each.internal && isTailnet(address) && status.ips.some((ip) => isTailnet(ip) && sameAddress(ip, address)))),
      )
      const addresses = Arr.sort([...new Set(found)], ADDRESS_ORDER)
      if (addresses.length === 0) return noTailnet("no-address")
      const names = Option.match(status.dnsName, { onNone: () => [], onSome: (name) => [...new Set([name, name.split(".")[0] ?? name])] })
      return { addresses, names, why: "" }
    },
  })

/** An address as a URL's or a Host header's host: an IPv6 one in brackets. */
export const hostOf = (address: string): string => Option.match(Option.liftPredicate(address, (each) => each.includes(":")), { onNone: () => address, onSome: (v6) => `[${v6}]` })

/** The `Host` values a listener on `port` answers to: each of its addresses and names, with the port. */
export const hostsOf = (port: number, addressesAndNames: ReadonlyArray<string>): ReadonlyArray<string> => addressesAndNames.map((each) => `${hostOf(each)}:${port}`)

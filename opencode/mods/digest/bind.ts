// Where the digest page may listen: loopback, and the host's own tailnet addresses. Nothing else, in code: a bind on
// any other address (a wildcard, a LAN address, a public one) is refused before a socket is made (`bindable`).
//
// - Loopback: 127.0.0.0/8 and ::1.
// - The tailnet: Tailscale's ranges, 100.64.0.0/10 (IPv4, shared CGNAT space) and fd7a:115c:a1e0::/48 (IPv6).
// - The host's tailnet addresses are those of its interfaces inside those ranges (`tailnetOf`), read at the
//   plugin's start and again every recheck, so a Tailscale that goes down, comes up or moves is followed. No such
//   address (Tailscale absent or down): loopback only.
// - The listener's own names (`namesOf`): each address, and the MagicDNS name and short host name when Tailscale's
//   status gives them. A request naming any other host is refused (DNS rebinding), on every route.
import { Array as Arr, Data, Option, Order } from "effect"

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

/** What Tailscale says of this host, when its CLI answers: whether it runs, and its MagicDNS name. */
export interface TailscaleStatus {
  readonly running: boolean
  /** `host.tailnet.ts.net`, without the trailing dot; none when MagicDNS is off. */
  readonly dnsName: Option.Option<string>
}

/** This host on the tailnet, as the page's second listener needs it: its addresses there, and its names. */
export interface Tailnet {
  readonly addresses: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
}

export const NO_TAILNET: Tailnet = { addresses: [], names: [] }

/** Addresses as the listeners are made: IPv4 before IPv6, then by code units. */
const ADDRESS_ORDER: Order.Order<string> = Order.combine(Order.mapInput(Order.Number, (address: string) => Number(address.includes(":"))), Order.String)

/**
 * The host on the tailnet, from its interfaces and Tailscale's status: the interface addresses in the tailnet's
 * ranges (IPv4 first), none when the status says Tailscale is not running. The names are the MagicDNS name and its
 * first label. No status (no CLI): the addresses alone.
 */
export const tailnetOf = (interfaces: ReadonlyArray<InterfaceAddress>, status: Option.Option<TailscaleStatus>): Tailnet => {
  if (Option.exists(status, (each) => !each.running)) return NO_TAILNET
  const found = interfaces.flatMap((each) => Option.toArray(Option.liftPredicate(each.address, (address) => !each.internal && isTailnet(address))))
  const addresses = Arr.sort([...new Set(found)], ADDRESS_ORDER)
  if (addresses.length === 0) return NO_TAILNET
  const dns = Option.flatMap(status, (each) => each.dnsName)
  const names = Option.match(dns, { onNone: () => [], onSome: (name) => [...new Set([name, name.split(".")[0] ?? name])] })
  return { addresses, names }
}

/** An address as a URL's or a Host header's host: an IPv6 one in brackets. */
export const hostOf = (address: string): string => Option.match(Option.liftPredicate(address, (each) => each.includes(":")), { onNone: () => address, onSome: (v6) => `[${v6}]` })

/** The `Host` values a listener on `port` answers to: each of its addresses and names, with the port. */
export const hostsOf = (port: number, addressesAndNames: ReadonlyArray<string>): ReadonlyArray<string> => addressesAndNames.map((each) => `${hostOf(each)}:${port}`)

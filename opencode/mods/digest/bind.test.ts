// Where the page may listen: loopback and the tailnet's ranges, nothing else; the host's tailnet as Tailscale's own
// status names it (Self.TailscaleIPs), on the host's interfaces. Addresses here are invented (documentation and
// range-edge values).
import { describe, expect, test } from "bun:test"
import { Match, Option } from "effect"
import { type InterfaceAddress, bindable, groupsOf, hostsOf, isLoopback, isTailnet, StatusRead, type TailscaleStatus, tailnetOf } from "./bind.ts"

describe("bindable", () => {
  test("loopback and the tailnet's ranges may be bound, at their edges too", () => {
    for (const address of ["127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "100.64.0.0", "100.127.255.255", "100.101.102.103", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff"])
      expect([address, Option.isNone(bindable(address))]).toEqual([address, true])
  })

  test("a wildcard, a LAN, a public, a link-local or a just-outside-the-range address is refused", () => {
    const refused = [
      "0.0.0.0",
      "::",
      "",
      "localhost",
      "192.168.1.5",
      "10.0.0.1",
      "172.16.0.1",
      "203.0.113.7",
      "100.63.255.255",
      "100.128.0.0",
      "fe80::1",
      "fd7a:115c:a1e1::1",
      "fd7a:115c::1",
      "2001:db8::1",
      "::ffff:192.168.1.5",
      "100.64.0.1.5",
      "256.64.0.1",
      "fd7a:115c:a1e0::1%utun0",
      "fd7a:115c:a1e0:::1",
    ]
    for (const address of refused) expect([address, Option.getOrUndefined(bindable(address))?._tag]).toEqual([address, "BindRefused"])
  })

  test("an IPv6 address reads the same however it is written", () => {
    expect(groupsOf("fd7a:115c:a1e0::1")).toEqual(Option.some([0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1]))
    expect(groupsOf("::ffff:127.0.0.1")).toEqual(Option.some([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]))
    expect([groupsOf("1:2:3:4:5:6:7"), groupsOf("1::2::3"), groupsOf("1:2:3:4:5:6:7:8:9")]).toEqual([Option.none(), Option.none(), Option.none()])
    expect([isLoopback("::1"), isTailnet("FD7A:115C:A1E0::abcd")]).toEqual([true, true])
  })
})

const nic = (address: string, internal = false): InterfaceAddress => ({ address, family: String(["IPv4", "IPv6"][Number(address.includes(":"))]), internal })
const status = (ips: ReadonlyArray<string>, backendState = "Running"): StatusRead => StatusRead.Read({ status: { backendState, dnsName: Option.some("harbor.example-tailnet.ts.net"), ips, peers: [] } satisfies TailscaleStatus })

describe("the host on the tailnet", () => {
  // His Tailscale addresses, and beside them a WARP-like interface and a carrier hotspot's en0, both in 100.64.0.0/10.
  const interfaces = [nic("127.0.0.1", true), nic("192.168.1.5"), nic("fe80::1"), nic("fd7a:115c:a1e0::42"), nic("100.101.102.103"), nic("100.96.0.7"), nic("100.72.14.9")]
  const running = status(["100.101.102.103", "fd7a:115c:a1e0::42"])

  test("its addresses are Tailscale's own on an interface, IPv4 first; another CGNAT interface is never one; its names the MagicDNS name and its first label", () => {
    expect(tailnetOf(interfaces, running)).toEqual({ addresses: ["100.101.102.103", "fd7a:115c:a1e0::42"], names: ["harbor.example-tailnet.ts.net", "harbor"], why: "" })
    expect(hostsOf(8240, ["100.101.102.103", "fd7a:115c:a1e0::42", "harbor"])).toEqual(["100.101.102.103:8240", "[fd7a:115c:a1e0::42]:8240", "harbor:8240"])
  })

  test("Tailscale down, its address on no interface, or no status at all: no tailnet, with the reason, never a wider one", () => {
    expect(tailnetOf(interfaces, status(["100.101.102.103"], "Stopped"))).toEqual({ addresses: [], names: [], why: "not-running:Stopped" })
    expect(tailnetOf(interfaces.slice(0, 3), running)).toEqual({ addresses: [], names: [], why: "no-address" })
    for (const why of ["no-cli", "cli-failed", "cli-timeout", "unparseable"]) expect(tailnetOf(interfaces, StatusRead.Unread({ why }))).toEqual({ addresses: [], names: [], why })
  })

  test("an address the CLI prints outside the ranges (a fake or broken CLI) is never one, even on an interface", () => {
    expect(tailnetOf([...interfaces, nic("0.0.0.0")], status(["192.168.1.5", "0.0.0.0", "100.101.102.103"])).addresses).toEqual(["100.101.102.103"])
  })

  test("an IPv6 address matches however the CLI and the interface write it", () => {
    expect(tailnetOf([nic("fd7a:115c:a1e0:0:0:0:0:42")], status(["FD7A:115C:A1E0::42"])).addresses).toEqual(["fd7a:115c:a1e0:0:0:0:0:42"])
  })
})

// A small seeded generator: the property runs the same cases on every run.
const generator = (seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  return {
    pick: <A>(all: ReadonlyArray<A>): A => Option.getOrThrow(Option.fromUndefinedOr(all[Math.floor(next() * all.length)])),
    some: <A>(all: ReadonlyArray<A>): ReadonlyArray<A> => all.filter(() => next() < 0.4),
  }
}

/** Addresses a host or a CLI may name: Tailscale-like, other CGNAT, LAN, loopback, wildcards, link-local, out of range. */
const POOL = [
  "100.101.102.103",
  "100.64.0.1",
  "100.127.255.254",
  "100.96.0.7",
  "100.72.14.9",
  "fd7a:115c:a1e0::42",
  "fd7a:115c:a1e0:0:0:0:0:43",
  "fd7a:115c:a1e1::1",
  "192.168.1.5",
  "10.0.0.1",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::",
  "fe80::1",
  "100.63.255.255",
  "100.128.0.0",
  "203.0.113.7",
]
const sameAddress = (a: string, b: string) => a === b || Option.getOrElse(Option.zipWith(groupsOf(a), groupsOf(b), (x, y) => x.join(":") === y.join(":")), () => false)

describe("the host on the tailnet, as a property over generated interfaces and statuses", () => {
  test("an address is returned only if it is in Self.TailscaleIPs AND on a non-internal interface AND in the tailnet's ranges; none unless Running", () => {
    const random = generator(20_261_122)
    for (let run = 0; run < 2_000; run++) {
      const interfaces = random.some(POOL).map((address) => nic(address, random.pick([false, false, true])))
      const read = random.pick<StatusRead>([
        status(random.some(POOL)),
        status(random.some(POOL)),
        status(random.some(POOL), random.pick(["Stopped", "NeedsLogin", "Starting"])),
        StatusRead.Unread({ why: random.pick(["no-cli", "cli-failed", "cli-timeout", "unparseable"]) }),
      ])
      const found = tailnetOf(interfaces, read)
      const ips = Match.valueTags(read, { Read: ({ status: each }) => each.ips.filter(() => each.backendState === "Running"), Unread: () => [] })
      const expected = interfaces.filter((each) => !each.internal && isTailnet(each.address) && ips.some((ip) => sameAddress(ip, each.address)))
      const facts = { interfaces, read, found }
      expect([facts, new Set(found.addresses)]).toEqual([facts, new Set(expected.map((each) => each.address))])
      for (const address of found.addresses) expect([address, Option.isNone(bindable(address))]).toEqual([address, true])
      if (found.addresses.length === 0) expect([facts, found.names, found.why === ""]).toEqual([facts, [], false])
    }
  })
})

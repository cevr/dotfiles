// Where the page may listen: loopback and the tailnet's ranges, nothing else; the host's tailnet as its interfaces and
// Tailscale's status show it. Addresses here are invented (documentation and range-edge values).
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { bindable, groupsOf, hostsOf, isLoopback, isTailnet, NO_TAILNET, tailnetOf } from "./bind.ts"

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

describe("the host on the tailnet", () => {
  const interfaces = [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "192.168.1.5", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "fd7a:115c:a1e0::42", family: "IPv6", internal: false },
    { address: "100.101.102.103", family: "IPv4", internal: false },
  ]
  const running = { running: true, dnsName: Option.some("harbor.example-tailnet.ts.net") }

  test("its addresses are the interfaces' in the tailnet's ranges, IPv4 first; its names the MagicDNS name and its first label", () => {
    expect(tailnetOf(interfaces, Option.some(running))).toEqual({ addresses: ["100.101.102.103", "fd7a:115c:a1e0::42"], names: ["harbor.example-tailnet.ts.net", "harbor"] })
    expect(hostsOf(8240, ["100.101.102.103", "fd7a:115c:a1e0::42", "harbor"])).toEqual(["100.101.102.103:8240", "[fd7a:115c:a1e0::42]:8240", "harbor:8240"])
  })

  test("Tailscale down, or no tailnet address: no tailnet, never a wider one", () => {
    expect(tailnetOf(interfaces, Option.some({ running: false, dnsName: Option.none() }))).toEqual(NO_TAILNET)
    expect(tailnetOf(interfaces.slice(0, 3), Option.some(running))).toEqual(NO_TAILNET)
    expect(tailnetOf(interfaces.slice(0, 3), Option.none())).toEqual(NO_TAILNET)
  })

  test("no Tailscale CLI: the interfaces' addresses alone, and no names", () => {
    expect(tailnetOf(interfaces, Option.none())).toEqual({ addresses: ["100.101.102.103", "fd7a:115c:a1e0::42"], names: [] })
  })
})

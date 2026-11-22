// The peers' wire and their place on the tailnet: what a peer's answer comes to (up, down, needs update), a newer
// peer's unknown message skipped alone, and a peer found only in Tailscale's own status.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import { canonicalOf, type PeerStatus, StatusRead } from "./bind.ts"
import { DigestEvent, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"
import { NO_MARKS } from "./marks.ts"
import { pageOf } from "./messages.ts"
import { browserSpelling, envelopeOf, keyedOf, locateIn, mergeView, NOT_ALLOWED, peerOriginsOf, Reading, readingOf, selfPagesOf, type Sighting, WIRE } from "./peers.ts"
import { viewOf } from "./view.ts"

const T = Date.parse("2026-11-20T12:00:00Z")
const run = DigestEvent.cases.Run.make({ v: VERSION, t: T, root: "r", host: "harbor", repo: "harbor", dir: Option.none(), name: Option.some("harbor") })
const item = DigestEvent.cases.Item.make({ answer: Option.none(), choices: Option.none(), v: VERSION, t: T, root: "r", id: "a", text: "Billing ships.", state: "done", owner: "mine", who: Option.none(), level: Option.none(), unit: Option.none() })
const VIEW = viewOf(pageOf(fold(EMPTY, [run, item]), { names: new Map() }), NO_MARKS, T + 1000, "UTC")
const ENVELOPE = envelopeOf("workbox", VIEW)
const UNREADABLE = Reading.Down({ reason: "it answered something unreadable" })

describe("a peer's answer", () => {
  test("its envelope is up with its view; no route, another wire, garbage, an error or a truncated body is not", () => {
    expect(readingOf(200, ENVELOPE)).toEqual(Reading.Up({ view: VIEW }))
    expect(readingOf(404, "no such page")).toEqual(Reading.Update({ reason: "peer needs update (it serves no peer view)" }))
    expect(readingOf(200, `{"wire":${WIRE + 1},"view":"anything at all"}`)).toEqual(Reading.Update({ reason: `peer needs update (its wire is ${WIRE + 1}, this build reads ${WIRE})` }))
    expect(readingOf(200, '{"wire":0}')).toEqual(Reading.Update({ reason: `peer needs update (its wire is 0, this build reads ${WIRE})` }))
    expect(readingOf(200, "<html>a captive portal</html>")).toEqual(UNREADABLE)
    expect(readingOf(200, ENVELOPE.slice(0, -20))).toEqual(UNREADABLE)
    expect(readingOf(200, `{"wire":${WIRE},"host":"workbox","view":{"projects":"elsewhere"}}`)).toEqual(UNREADABLE)
    expect(readingOf(401, "pair first")).toEqual(Reading.Down({ reason: NOT_ALLOWED }))
    expect(readingOf(403, "not from here")).toEqual(Reading.Down({ reason: NOT_ALLOWED }))
    expect(readingOf(503, "restarting")).toEqual(Reading.Down({ reason: "it answered 503" }))
  })

  test("a newer peer's message of a kind this build does not know is left out alone; the rest of its view shows", () => {
    const wire = JSON.parse(ENVELOPE)
    const known = wire.view.projects[0].inbox[0]
    wire.view.projects[0].inbox.push({ ...known, id: "agent:workbox:1", kind: "agent-answer", extra: { proposed: "yes" } })
    wire.view.projects[0].mood = "a field a later build added"
    const reading = readingOf(200, JSON.stringify(wire))
    expect(reading).toEqual(Reading.Up({ view: VIEW }))
  })
})

const HIS = 7
const device = (name: string, id: string, ips: ReadonlyArray<string>, more: Partial<PeerStatus> = {}): PeerStatus => ({
  dnsName: Option.some(`${name}.example-tailnet.ts.net.`),
  stableId: Option.some(id),
  hostName: name,
  os: "linux",
  lastSeen: Option.none(),
  ips,
  userId: Option.some(HIS),
  tagged: false,
  shared: false,
  ...more,
})
const sightingOf = (peers: ReadonlyArray<PeerStatus>, more: Partial<Sighting> = {}, backendState = "Running"): Sighting => ({
  read: StatusRead.Read({ status: { backendState, dnsName: Option.some("harbor.example-tailnet.ts.net"), ips: ["100.101.102.103"], userId: Option.some(HIS), tagged: false, peers } }),
  agents: [{ name: "workbox", ids: ["nWORK"] }],
  excluded: [],
  at: T,
  ...more,
})
const WORKBOX = device("Workbox", "nWORK", ["fd7a:115c:a1e0::9", "100.101.102.104", "192.168.1.4"])

describe("a peer on the tailnet", () => {
  test("is the one device of his the store keys for its name: by stable ID, at its tailnet addresses only (IPv4 first), whatever it is called now", () => {
    expect(keyedOf("workbox", sightingOf([WORKBOX]), T)).toEqual(Option.some({ ips: ["100.101.102.104", "fd7a:115c:a1e0::9"] }))
    // Renamed: still that device, under its new name.
    expect(keyedOf("workbox", sightingOf([{ ...WORKBOX, dnsName: Option.some("spare.example-tailnet.ts.net") }]), T)).toEqual(
      Option.some({ ips: ["100.101.102.104", "fd7a:115c:a1e0::9"] }),
    )
  })

  test("is nowhere when a name alone would find it: unkeyed, another device of his or a colleague's taking the name, an excluded or ambiguous ID", () => {
    const colleague = device("workbox", "nCOLL", ["100.101.102.120"], { userId: Option.some(9) })
    const another = device("workbox", "nPHONE", ["100.101.102.110"])
    expect(keyedOf("workbox", sightingOf([WORKBOX], { agents: [{ name: "workbox", ids: [] }] }), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX], { agents: [] }), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([colleague, another]), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([{ ...WORKBOX, userId: Option.some(9) }]), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([{ ...WORKBOX, tagged: true }]), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([{ ...WORKBOX, shared: true }]), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX], { excluded: [{ name: "lenovo-rescue", ids: ["nWORK"] }] }), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX, device("workbox2", "nWORK2", ["100.101.102.105"])], { agents: [{ name: "workbox", ids: ["nWORK", "nWORK2"] }] }), T)).toEqual(Option.none())
    // With the keyed device there, the others change nothing.
    expect(Option.map(keyedOf("workbox", sightingOf([colleague, another, WORKBOX]), T), (each) => each.ips)).toEqual(Option.some(["100.101.102.104", "fd7a:115c:a1e0::9"]))
  })

  test("is nowhere while the status is unread, Tailscale stopped or the read stale; an address another device lists is not its", () => {
    expect(keyedOf("workbox", sightingOf([WORKBOX], {}, "Stopped"), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX], { read: StatusRead.Unread({ why: "no-cli" }) }), T)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX]), T + 76_000)).toEqual(Option.none())
    expect(keyedOf("workbox", sightingOf([WORKBOX], { at: 0 }), T)).toEqual(Option.none())
    const contested = [WORKBOX, device("laptop", "nLAP", ["100.101.102.104"], { userId: Option.some(9) })]
    expect(Option.map(keyedOf("workbox", sightingOf(contested), T), (each) => each.ips)).toEqual(Option.some(["fd7a:115c:a1e0::9"]))
  })

  test("a named peer is read at its keyed device's first address on the page's port; one not keyed or not there is nowhere", () => {
    const named = [
      { name: "workbox", host: "workbox" },
      { name: "phone", host: "phone" },
    ]
    expect(locateIn(named, sightingOf([WORKBOX, device("phone", "nPHONE", ["100.101.102.110"])]), T, 8240)).toEqual(new Map([["workbox", { name: "workbox", base: "http://100.101.102.104:8240" }]]))
    expect(locateIn(named, sightingOf([]), T, 8240)).toEqual(new Map())
  })
})

/** A seeded generator of numbers in [0, 1) (mulberry32). */
const drawer = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

describe("the origins a host lets write here cross-origin (round 2's B1)", () => {
  const PORT = 8240
  const NAMES = ["macbook", "workbox", "phone", "laptop", "spare"]
  const DOMAINS = ["example-tailnet.ts.net", "other-tailnet.ts.net"]
  /** `yes` when `cond`, else `no`. */
  const when = <A,>(cond: boolean, yes: A, no: A): A => Option.getOrElse(Option.as(Option.liftPredicate(cond, Boolean), yes), () => no)
  /** An address as a URL's host spells it: IPv6 in brackets. */
  const bracketed = (ip: string) => when(ip.includes(":"), `[${ip}]`, ip)
  const labelOf = (name: string) => Option.getOrElse(Arr.head(name.split(".")), () => name)
  /** Every form a browser could send for `peer`, its names included, and near misses of each. */
  const formsOf = (peer: PeerStatus): ReadonlyArray<string> => {
    const name = Option.getOrElse(peer.dnsName, () => "").replace(/\.$/, "")
    const places = [...peer.ips.map(bracketed), name, labelOf(name), peer.hostName].filter((each) => each !== "")
    return places.flatMap((place) => [`http://${place}:${PORT}`, `http://${place}:${PORT + 1}`, `https://${place}:${PORT}`, `http://${place.toUpperCase()}:${PORT}`, `http://${place}`])
  }

  test("over generated statuses: allowed iff it is exactly http://<address>:<port> of the keyed device's current addresses; never a name", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const draw = drawer(seed)
      const pick = <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(all, Math.floor(draw() * all.length)))
      const ip4 = () => `100.${64 + Math.floor(draw() * 64)}.${Math.floor(draw() * 256)}.${1 + Math.floor(draw() * 254)}`
      const ip6 = () => `fd7a:115c:a1e0::${(1 + Math.floor(draw() * 0xfffe)).toString(16)}`
      // The keyed device, under any name now (renamed, or a name another device also carries).
      const keyed: PeerStatus = { ...device(pick(NAMES), "nKEY", [ip4(), ip6()]), dnsName: Option.some(`${pick(NAMES)}.${pick(DOMAINS)}`) }
      const keyedName = Option.getOrElse(keyed.dnsName, () => "x")
      const others: ReadonlyArray<PeerStatus> = Array.from({ length: Math.floor(draw() * 5) }, (_, n) => {
        const kind = pick(["his", "colleague", "shared", "tagged"] as const)
        // Some carry the keyed device's name, its label or its HostName; some list one of its addresses (contested).
        const name = pick([...NAMES, labelOf(keyedName)])
        return {
          ...device(name, `n${n}`, [when(draw() < 0.15, pick(keyed.ips), ip4())]),
          dnsName: Option.some(when(draw() < 0.3, keyedName, `${name}.${pick(DOMAINS)}`)),
          hostName: pick([name, keyed.hostName]),
          userId: Option.some(when(kind === "colleague", 9, HIS)),
          shared: kind === "shared",
          tagged: kind === "tagged",
        }
      })
      const present = draw() < 0.85
      const keyedByStore = draw() < 0.85
      const sighting = sightingOf([...others, ...when(present, [keyed], [])], { agents: [{ name: "macbook", ids: when(keyedByStore, ["nKEY"], []) }] })
      const allowed = peerOriginsOf([{ name: "macbook", host: "macbook" }], sighting, T, PORT)
      // The oracle: the keyed device's addresses no other device (nor this host) lists, as a browser spells them.
      const listedElsewhere = new Set(["100.101.102.103", ...others.flatMap((each) => each.ips)])
      const expected = when(
        present && keyedByStore,
        keyed.ips.flatMap((ip) => Option.toArray(Option.liftPredicate(`http://${bracketed(ip)}:${PORT}`, () => !listedElsewhere.has(ip)))),
        [],
      )
      expect(new Set(allowed), `seed ${seed}`).toEqual(new Set(expected))
      for (const origin of [...formsOf(keyed), ...others.flatMap(formsOf)]) expect(allowed.includes(origin), `seed ${seed}: ${origin}`).toBe(expected.includes(origin))
      for (const origin of allowed) expect(new URL(origin).hostname, `seed ${seed}`).toMatch(/^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/)
    }
  })

  test("this host's own page by address: its Tailscale addresses on the port, none when the read is stale, stopped or unread", () => {
    const self = (ips: ReadonlyArray<string>, backendState = "Running"): Sighting => ({
      ...sightingOf([]),
      read: StatusRead.Read({ status: { backendState, dnsName: Option.some("harbor.example-tailnet.ts.net"), ips, userId: Option.some(HIS), tagged: false, peers: [] } }),
    })
    expect(selfPagesOf(self(["fd7a:115c:a1e0:0:0:0:0:3", "100.101.102.103", "192.168.1.9"]), T, PORT)).toEqual(["http://100.101.102.103:8240", "http://[fd7a:115c:a1e0::3]:8240"])
    expect(selfPagesOf(self(["100.101.102.103"], "Stopped"), T, PORT)).toEqual([])
    expect(selfPagesOf(self(["100.101.102.103"]), T + 76_000, PORT)).toEqual([])
    expect(selfPagesOf({ ...self(["100.101.102.103"]), read: StatusRead.Unread({ why: "no-cli" }) }, T, PORT)).toEqual([])
  })

  test("an address is spelled as a browser spells it in Origin (the WHATWG URL serializer), whatever form it came in", () => {
    expect(["fd7a:115c:a1e0:0:0:0:0:9", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "1:0:0:2:0:0:0:3", "1:0:2:3:4:5:6:7", "1:0:0:2:0:0:3:4", "100.101.102.104"].map(browserSpelling)).toEqual([
      "fd7a:115c:a1e0::9",
      "::1",
      "::",
      "1:0:0:2::3",
      "1:0:2:3:4:5:6:7",
      "1::2:0:0:3:4",
      "100.101.102.104",
    ])
    const draw = drawer(7)
    for (let n = 0; n < 2000; n++) {
      const groups = Array.from({ length: 8 }, () => when(Math.floor(draw() * 3) === 0, "0", Math.floor(draw() * 0x10000).toString(16)))
      const canonical = Option.getOrThrow(canonicalOf(groups.join(":")))
      expect(`[${browserSpelling(canonical)}]`, canonical).toBe(new URL(`http://[${canonical}]/`).hostname)
    }
  })

  test("a peer's own view cannot choose where this page writes: the merged origin is where this host found the peer", () => {
    const hostile = { ...VIEW, projects: VIEW.projects.map((project) => ({ ...project, origin: Option.some("http://evil.example:8240"), host: Option.some("harbor") })) }
    const merged = mergeView(VIEW, "harbor", [{ name: "workbox", origin: Option.some("http://100.101.102.104:8240"), reading: Reading.Up({ view: hostile }), lastSeen: Option.some(T) }])
    const theirs = merged.projects.filter((project) => project.id.startsWith("peer:"))
    expect(theirs.length).toBeGreaterThan(0)
    expect(theirs.map((project) => [project.origin, project.host])).toEqual(theirs.map(() => [Option.some("http://100.101.102.104:8240"), Option.some("workbox")]))
    expect(Option.map(merged.peers, (peers) => peers.map((peer) => peer.origin))).toEqual(Option.some([Option.some("http://100.101.102.104:8240")]))
  })
})


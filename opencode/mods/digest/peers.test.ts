// The peers' wire and their place on the tailnet: what a peer's answer comes to (up, down, needs update), a newer
// peer's unknown message skipped alone, and a peer found only in Tailscale's own status.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type PeerStatus, StatusRead } from "./bind.ts"
import { DigestEvent, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"
import { NO_MARKS } from "./marks.ts"
import { pageOf } from "./messages.ts"
import { envelopeOf, keyedOf, locateIn, NOT_ALLOWED, Reading, readingOf, type Sighting, WIRE } from "./peers.ts"
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
    expect(keyedOf("workbox", sightingOf([WORKBOX]), T)).toEqual(Option.some({ ips: ["100.101.102.104", "fd7a:115c:a1e0::9"], dnsName: Option.some("workbox.example-tailnet.ts.net") }))
    // Renamed: still that device, under its new name.
    expect(keyedOf("workbox", sightingOf([{ ...WORKBOX, dnsName: Option.some("spare.example-tailnet.ts.net") }]), T)).toEqual(
      Option.some({ ips: ["100.101.102.104", "fd7a:115c:a1e0::9"], dnsName: Option.some("spare.example-tailnet.ts.net") }),
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


// The peers' wire and their place on the tailnet: what a peer's answer comes to (up, down, needs update), a newer
// peer's unknown message skipped alone, a slow peer cut off, and a peer found only in Tailscale's own status.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Option } from "effect"
import { peerHostsOf, StatusRead } from "./bind.ts"
import { DigestEvent, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"
import { readOne } from "./http/peers.ts"
import { NO_MARKS } from "./marks.ts"
import { pageOf } from "./messages.ts"
import { envelopeOf, Reading, readingOf, targetOf, WIRE } from "./peers.ts"
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
    expect(readingOf(401, "pair first")).toEqual(Reading.Down({ reason: "it needs pairing to be read (its digest.tailnetRead is paired)" }))
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

  test("a peer that never answers is down after the timeout, and one that cannot be reached is down at once", async () => {
    const target = { name: "workbox", base: "http://127.0.0.1:9" }
    expect(await Effect.runPromise(readOne(() => Effect.never, target, Duration.millis(20)))).toEqual(Reading.Down({ reason: "no answer in 0.02 s" }))
    expect(await Effect.runPromise(readOne(() => Effect.fail("ECONNREFUSED"), target))).toEqual(Reading.Down({ reason: "unreachable" }))
  })
})

describe("a peer on the tailnet", () => {
  const status = (backendState: string) =>
    StatusRead.Read({
      status: {
        backendState,
        dnsName: Option.some("harbor.example-tailnet.ts.net"),
        ips: ["100.101.102.103"],
        peers: [
          { dnsName: "Workbox.example-tailnet.ts.net.", ips: ["fd7a:115c:a1e0::9", "100.101.102.104"] },
          { dnsName: "phone.example-tailnet.ts.net", ips: ["192.168.1.4"] },
          { dnsName: "", ips: ["100.101.102.105"] },
        ],
      },
    })

  test("is found in Tailscale's status by its short name, at its tailnet addresses only, IPv4 first; none when it is not running", () => {
    expect(peerHostsOf(status("Running"))).toEqual([{ host: "workbox", dnsName: "workbox.example-tailnet.ts.net", ips: ["100.101.102.104", "fd7a:115c:a1e0::9"] }])
    expect(peerHostsOf(status("Stopped"))).toEqual([])
    expect(peerHostsOf(StatusRead.Unread({ why: "no-cli" }))).toEqual([])
  })

  test("a named peer is read at its first address on the page's port; one Tailscale does not list is nowhere", () => {
    const hosts = peerHostsOf(status("Running"))
    expect(targetOf({ name: "workbox", host: "workbox" }, hosts, 8240)).toEqual(Option.some({ name: "workbox", base: "http://100.101.102.104:8240" }))
    expect(targetOf({ name: "phone", host: "phone" }, hosts, 8240)).toEqual(Option.none())
    expect(targetOf({ name: "evil", host: "evil.example.com" }, hosts, 8240)).toEqual(Option.none())
  })
})

// The page's policy as a model, checked against a small reference written apart from it:
// - every combination of listener, route, source, paired, origin, host, headers and the two switches
//   (`digest.tailnetRead`, `digest.tailnetWrite`) gives what the reference gives;
// - and from a request's raw source address, through his devices as Tailscale's status names them (members.ts), for
//   this host, a named agent host, another of his devices, another user's, a tagged or shared-in one, an address the
//   status lacks and one outside the tailnet, each as IPv4, IPv6 and IPv4-mapped IPv6.
// Addresses, names and users are invented.
import { describe, expect, test } from "bun:test"
import { Duration, Match, Option } from "effect"
import { StatusRead, type TailscaleStatus } from "./bind.ts"
import { closed, current, MEMBERS_TTL, membersOf, sourceOf, writesWord } from "./members.ts"
import { ACCESS, type Decision, decide, type Facts, type Listener, mayAnswer, type Policy, ROUTE_KINDS, type RouteKind, type Source, SOURCES, TAILNET_WRITES, WRITES } from "./policy.ts"

const LOOPBACK_HOSTS = ["127.0.0.1:8240", "localhost:8240"]
/** The tailnet listener bound on 100.101.102.103: it serves under that address alone; its names only redirect. */
const TAILNET_HOSTS = ["100.101.102.103:8240"]
const TAILNET_NAMES = ["harbor.example-tailnet.ts.net:8240", "harbor:8240"]
const HOSTS_OF: Readonly<Record<Listener, ReadonlyArray<string>>> = { loopback: LOOPBACK_HOSTS, tailnet: TAILNET_HOSTS }
const NAMES_OF: Readonly<Record<Listener, ReadonlyArray<string>>> = { loopback: [], tailnet: TAILNET_NAMES }

/**
 * The hosts a request may name: each of the listener's own, its names, the other listener's (its IPv6 address),
 * a name spelled as no browser sends it (upper case, a trailing dot), the address without its port or another port,
 * a rebound name, none.
 */
const HOSTS = [...LOOPBACK_HOSTS, ...TAILNET_HOSTS, ...TAILNET_NAMES, "[fd7a:115c:a1e0::42]:8240", "HARBOR:8240", "harbor.example-tailnet.ts.net.:8240", "100.101.102.103", "evil.example:8240", "100.101.102.103:9999", ""]
/** The kinds that answer with the page's data (the view, the marks it changes, an answer, the health line's counts). */
const DATA: ReadonlyArray<RouteKind> = ["read", "mark", "answer", "health"]
const POLICIES: ReadonlyArray<Policy> = (["paired", "member"] as const).flatMap((tailnetRead) => TAILNET_WRITES.map((tailnetWrite) => ({ tailnetRead, tailnetWrite })))

const status = (decision: Decision): number | string => Match.valueTags(decision, { Refuse: (refused) => refused.status, Serve: () => "Serve", Brief: () => "Brief", Redirect: () => "Redirect" })

/**
 * The reference: what each request gets, written as plainly as possible and apart from policy.ts.
 * - The authority first: a tailnet name redirects GET / and is refused (421) otherwise; then a Host the listener
 *   does not serve under (421), then a tailnet request from outside the tailnet (403), then on the tailnet an Origin
 *   that is sent and is not the page's own (403); then a write's origin, header, JSON.
 * - Loopback: everything open but an answer, which needs pairing.
 * - Tailnet: the shell, status and pairing open; health `ok` alone unless paired; a read open to his devices
 *   (own, agent) under read "member"; a mark or answer open to his devices under write "member", to his devices but
 *   the agent machines under "member-except-hosts". Anything else needs pairing.
 */
const reference = (facts: Facts, policy: Policy): number | string => Option.getOrElse(refusalOf(facts), () => servedOf(facts, policy))

/** The reference's answers before what a route needs: Host, a tailnet request from outside, a name, the origin, a write's header, JSON. */
const refusalOf = (facts: Facts): Option.Option<number | string> => {
  const named = facts.names.includes(facts.host)
  // The tailnet reads the authority before anything else: a name redirects a GET of `/`, and is refused otherwise.
  if (named) return Option.some([421, "Redirect"][Number(facts.kind === "shell" && facts.root)] ?? 421)
  if (!facts.hosts.includes(facts.host)) return Option.some(421)
  if (facts.listener === "tailnet" && (facts.source === "outside" || facts.source === "local")) return Option.some(403)
  if (facts.listener === "tailnet" && facts.origin !== "" && facts.origin !== `http://${facts.host}`) return Option.some(403)
  if (facts.kind !== "mark" && facts.kind !== "answer" && facts.kind !== "pair") return Option.none()
  if (facts.origin !== `http://${facts.host}` || !facts.pageHeader) return Option.some(403)
  return Option.liftPredicate(415, () => !facts.json)
}

/** The reference's answer once nothing refused it. */
const servedOf = (facts: Facts, policy: Policy): number | string => {
  if (facts.kind === "shell" || facts.kind === "status" || facts.kind === "pair" || facts.paired) return "Serve"
  if (facts.listener === "loopback" && facts.kind !== "answer") return "Serve"
  if (facts.listener === "loopback") return 401
  if (facts.kind === "health") return "Brief"
  if (openOnTailnet(facts, policy)) return "Serve"
  return 401
}

/** Whether the reference opens a tailnet read, mark or answer to an unpaired request by its source. */
const openOnTailnet = (facts: Facts, policy: Policy): boolean => {
  const mine = facts.source === "own" || facts.source === "agent"
  if (facts.kind === "read") return policy.tailnetRead === "member" && mine
  if (facts.kind !== "mark" && facts.kind !== "answer") return false
  return (policy.tailnetWrite === "member" && mine) || (policy.tailnetWrite === "member-except-hosts" && facts.source === "own")
}

/**
 * Every combination, with the origin as the request's own, another of the listener's hosts or names, a foreign one,
 * none, or `null`, and the path `/` or another.
 */
const combinations = (): ReadonlyArray<{ readonly facts: Facts; readonly policy: Policy }> =>
  (["loopback", "tailnet"] as const).flatMap((listener) =>
    ROUTE_KINDS.flatMap((kind) =>
      HOSTS.flatMap((host) =>
        [`http://${host}`, `http://${[...HOSTS_OF[listener], ...NAMES_OF[listener]].find((each) => each !== host) ?? ""}`, "http://evil.example", "", "null"].flatMap((origin) =>
          [true, false].flatMap((paired) =>
            [true, false].flatMap((pageHeader) =>
              [true, false].flatMap((json) =>
                [true, false].flatMap((root) =>
                  SOURCES.flatMap((source) => POLICIES.map((policy) => ({ facts: { listener, kind, source, host, hosts: HOSTS_OF[listener], names: NAMES_OF[listener], root, origin, pageHeader, json, paired }, policy }))),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

describe("the page's policy, at every combination", () => {
  const all = combinations()

  test(`it decides as the reference does (${all.length} combinations)`, () => {
    const wrong = all.filter(({ facts, policy }) => status(decide(facts, policy)) !== reference(facts, policy))
    expect(wrong.slice(0, 5)).toEqual([])
  })

  test("no route answers a Host that is not one of its listener's own", () => {
    expect(all.filter(({ facts, policy }) => !facts.hosts.includes(facts.host) && !facts.names.includes(facts.host) && status(decide(facts, policy)) !== 421)).toEqual([])
  })

  test("on the tailnet nothing is served under a name, token or not: GET / is sent on to the address, every other route is refused", () => {
    const named = all.filter(({ facts }) => facts.listener === "tailnet" && !facts.hosts.includes(facts.host))
    expect(named.filter(({ facts, policy }) => decide(facts, policy)._tag === "Serve" || decide(facts, policy)._tag === "Brief")).toEqual([])
    expect(named.filter(({ facts, policy }) => decide(facts, policy)._tag === "Redirect" && !(facts.kind === "shell" && facts.root && facts.names.includes(facts.host)))).toEqual([])
    expect(named.some(({ facts, policy }) => facts.paired && decide(facts, policy)._tag === "Redirect")).toBe(true)
  })

  test("on the tailnet whatever is served is served under the listener's own address, from no Origin or its own", () => {
    const served = all.filter(({ facts, policy }) => facts.listener === "tailnet" && decide(facts, policy)._tag !== "Refuse" && decide(facts, policy)._tag !== "Redirect")
    expect(served.filter(({ facts }) => facts.host !== "100.101.102.103:8240" || (facts.origin !== "" && facts.origin !== "http://100.101.102.103:8240"))).toEqual([])
    expect(served.length > 0).toBe(true)
  })

  test("no write is served from another origin than the Host it named (a foreign one, none, `null`), without the page's header, or not JSON, whatever the switches", () => {
    const served = all.filter(({ facts, policy }) => WRITES.includes(facts.kind) && (facts.origin !== `http://${facts.host}` || !facts.pageHeader || !facts.json) && decide(facts, policy)._tag !== "Refuse")
    expect(served).toEqual([])
  })

  test("on the tailnet, nothing from outside Tailscale's ranges is served, on any route (a name's redirect serves nothing)", () => {
    expect(all.filter(({ facts, policy }) => facts.listener === "tailnet" && facts.source === "outside" && decide(facts, policy)._tag !== "Refuse" && decide(facts, policy)._tag !== "Redirect")).toEqual([])
  })

  test("on the tailnet, unpaired, another user's device (or any address not his) gets no data from any route, whatever the switches", () => {
    expect(all.filter(({ facts, policy }) => facts.listener === "tailnet" && facts.source === "other" && !facts.paired && DATA.includes(facts.kind) && decide(facts, policy)._tag === "Serve")).toEqual([])
  })

  test("unpaired, an agent machine never marks or answers under member-except-hosts, and no device does under paired", () => {
    const served = all.filter(
      ({ facts, policy }) =>
        facts.listener === "tailnet" && !facts.paired && (facts.kind === "mark" || facts.kind === "answer") && (policy.tailnetWrite === "paired" || (policy.tailnetWrite === "member-except-hosts" && facts.source === "agent")) && decide(facts, policy)._tag === "Serve",
    )
    expect(served).toEqual([])
  })

  test("loopback is as before, whoever and whatever the switches: reads and marks open, an answer paired", () => {
    const base = { listener: "loopback", host: "127.0.0.1:8240", hosts: LOOPBACK_HOSTS, names: [], root: false, origin: "http://127.0.0.1:8240", pageHeader: true, json: true, paired: false } as const
    for (const policy of POLICIES) for (const source of SOURCES) expect(ROUTE_KINDS.map((kind) => [kind, status(decide({ ...base, kind, source }, policy))])).toEqual(ROUTE_KINDS.map((kind) => [kind, ["Serve", 401][Number(ACCESS.loopback[kind] !== "open")]]))
  })

  test("the table at the defaults", () => {
    expect(ACCESS).toEqual({
      loopback: { shell: "open", status: "open", health: "open", read: "open", mark: "open", answer: "paired", pair: "open" },
      tailnet: { shell: "open", status: "open", health: "brief", read: "paired", mark: "paired", answer: "paired", pair: "open" },
    })
  })

  test("/paired.json's `answers` is what an answer from there would get: served or not", () => {
    const reachable = all.filter(
      ({ facts }) => facts.kind === "answer" && facts.hosts.includes(facts.host) && facts.origin === `http://${facts.host}` && facts.pageHeader && facts.json && !(facts.listener === "tailnet" && (facts.source === "outside" || facts.source === "local")),
    )
    expect(reachable.filter(({ facts, policy }) => mayAnswer(facts.listener, policy, facts.source, facts.paired) !== (decide(facts, policy)._tag === "Serve"))).toEqual([])
  })
})

// ── From a source address, through his devices ──

const SELF = { v4: "100.101.102.103", v6: "fd7a:115c:a1e0::42" }
/** A tailnet: this host (user 7), an agent host named in config (skiff, user 7), his phone (user 7), a colleague's laptop (user 9), a tagged server and a device shared in (each user 7 on paper). */
const STATUS: TailscaleStatus = {
  backendState: "Running",
  dnsName: Option.some("harbor.example-tailnet.ts.net"),
  ips: [SELF.v4, SELF.v6],
  userId: Option.some(7),
  tagged: false,
  peers: [
    { dnsName: Option.some("skiff.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "skiff", ips: ["100.101.102.104", "fd7a:115c:a1e0::44"], userId: Option.some(7), tagged: false, shared: false },
    { dnsName: Option.some("phone.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "localhost", ips: ["100.101.102.110", "fd7a:115c:a1e0::110"], userId: Option.some(7), tagged: false, shared: false },
    { dnsName: Option.some("laptop.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "Colleague's MacBook", ips: ["100.101.102.120", "fd7a:115c:a1e0::120"], userId: Option.some(9), tagged: false, shared: false },
    { dnsName: Option.some("server.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "server", ips: ["100.101.102.121"], userId: Option.some(7), tagged: true, shared: false },
    { dnsName: Option.some("guest.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "guest", ips: ["100.101.102.122"], userId: Option.some(7), tagged: false, shared: true },
  ],
}

/** Each address a request may come from, every spelling, and who it is. */
const spellings = (v4: string, v6: Option.Option<string>): ReadonlyArray<string> => [v4, `::ffff:${v4}`, `0:0:0:0:0:ffff:${v4}`, ...Option.toArray(v6), ...Option.toArray(Option.map(v6, (each) => each.toUpperCase()))]
const ADDRESSES: ReadonlyArray<readonly [string, Source]> = [
  ...spellings(SELF.v4, Option.some(SELF.v6)).map((each) => [each, "agent"] as const),
  ...spellings("100.101.102.104", Option.some("fd7a:115c:a1e0::44")).map((each) => [each, "agent"] as const),
  ...spellings("100.101.102.110", Option.some("fd7a:115c:a1e0::110")).map((each) => [each, "own"] as const),
  ...spellings("100.101.102.120", Option.some("fd7a:115c:a1e0::120")).map((each) => [each, "other"] as const),
  ...spellings("100.101.102.121", Option.none()).map((each) => [each, "other"] as const),
  ...spellings("100.101.102.122", Option.none()).map((each) => [each, "other"] as const),
  ...spellings("100.127.0.9", Option.some("fd7a:115c:a1e0::9")).map((each) => [each, "other"] as const),
  ...["192.168.1.5", "::ffff:192.168.1.5", "127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "unknown", "", "harbor", "100.128.0.1", "fd7a:115c:a1e1::1", "fe80::1%en0"].map((each) => [each, "outside"] as const),
]

const NOW = 1_795_204_800_000
const membersAt = (tailnetWrite: Policy["tailnetWrite"], agentHosts: ReadonlyArray<string> = ["skiff"]) => membersOf({ tailnetWrite, agentHosts, excluded: [] }, StatusRead.Read({ status: STATUS }), NOW)

describe("who a source address is, from Tailscale's status", () => {
  test("this host and the agent host are agents, his phone his own, everyone else other or outside, in every spelling", () => {
    const members = membersAt("member-except-hosts")
    expect(ADDRESSES.map(([address]) => [address, sourceOf(address, members)])).toEqual(ADDRESSES.map(([address, source]) => [address, source]))
    expect([members.write, members.why, members.devices]).toEqual(["member-except-hosts", "", 2])
  })

  test("an agent host is resolved among his devices by its MagicDNS name, its first label or its address; never by HostName or DNS", () => {
    for (const entry of ["skiff", "SKIFF", "skiff.example-tailnet.ts.net", "skiff.example-tailnet.ts.net.", "100.101.102.104", "::ffff:100.101.102.104"]) expect([entry, sourceOf("100.101.102.104", membersAt("member-except-hosts", [entry]))]).toEqual([entry, "agent"])
    // A name only DNS knows, or an address outside the ranges, resolves to nothing: the writes close to paired, and health says which.
    for (const entry of ["skiff.example.com", "dinghy", "192.168.1.9"]) {
      const members = membersAt("member-except-hosts", ["skiff", entry])
      expect([entry, members.write, writesWord(members)]).toEqual([entry, "paired", `paired:unresolved:${entry}`])
    }
    // Under "member" an unresolved agent host closes nothing: agents are his devices there.
    expect(membersAt("member", ["dinghy"]).write).toBe("member")
  })

  test("a HostName, a colleague's MagicDNS name or address, a tagged or shared-in device's name: none is an agent host of his, and the writes close", () => {
    // "localhost" is his phone's HostName; laptop, server and guest are not his devices.
    const entries = [["localhost", "localhost"], ["Colleague's MacBook", "ColleaguesMacBook"], ["laptop", "laptop"], ["100.101.102.120", "100.101.102.120"], ["server", "server"], ["guest.example-tailnet.ts.net", "guest.example-tailnet.ts.net"]] as const
    for (const [entry, said] of entries) {
      const members = membersAt("member-except-hosts", [entry])
      expect([entry, writesWord(members), members.agents.length]).toEqual([entry, `paired:unresolved:${said}`, 2])
    }
  })

  test("no status, Tailscale not running, a tagged host, or members past their lifetime: no device is his", () => {
    for (const read of [StatusRead.Unread({ why: "cli-timeout" }), StatusRead.Read({ status: { ...STATUS, backendState: "Stopped" } })]) {
      const members = membersOf({ tailnetWrite: "member", agentHosts: ["skiff"], excluded: [] }, read, NOW)
      expect(ADDRESSES.flatMap(([address]) => [sourceOf(address, members)].filter((each) => each !== "other" && each !== "outside"))).toEqual([])
      expect(members.write).toBe("paired")
    }
    expect(sourceOf("100.101.102.110", membersOf({ tailnetWrite: "member", agentHosts: [], excluded: [] }, StatusRead.Read({ status: { ...STATUS, tagged: true } }), NOW))).toBe("other")
    const members = membersAt("member")
    expect(sourceOf("100.101.102.110", current(members, NOW + Duration.toMillis(MEMBERS_TTL)))).toBe("own")
    expect(sourceOf("100.101.102.110", current(members, NOW + Duration.toMillis(MEMBERS_TTL) + 1))).toBe("other")
    expect(writesWord(current(members, NOW + Duration.toMillis(MEMBERS_TTL) + 1))).toBe("paired:stale")
    expect(writesWord(closed("starting"))).toBe("paired:starting")
  })

  // The acceptance: (listener) × (source address, each spelling) × (token: valid or not) × (switches) × (route) ×
  // (origin and header: right, wrong, missing) against the reference, through membersOf and sourceOf.
  test("from every address, token, switch, route, origin and header: as the reference says", () => {
    const onListener = (listener: Listener, who: Source): Source => Match.value(listener).pipe(Match.when("loopback", (): Source => "local"), Match.orElse(() => who))
    /** One case: what the code decides from the raw address, and what the reference says from who the address is. */
    const check = (listener: Listener, address: string, who: Source, policy: Policy, kind: RouteKind, paired: boolean, origin: string, pageHeader: boolean) => {
      const members = membersAt(policy.tailnetWrite)
      const host = HOSTS_OF[listener][0] ?? ""
      const facts: Facts = { listener, kind, source: onListener(listener, sourceOf(address, members)), host, hosts: HOSTS_OF[listener], names: NAMES_OF[listener], root: false, origin: origin.replace("<own>", `http://${host}`), pageHeader, json: true, paired }
      const got = status(decide(facts, { tailnetRead: policy.tailnetRead, tailnetWrite: members.write }))
      const expected = reference({ ...facts, source: onListener(listener, who) }, policy)
      return Option.liftPredicate({ listener, address, kind, paired, origin, pageHeader, policy, got, expected }, () => got !== expected)
    }
    const ORIGINS: ReadonlyArray<readonly [string, boolean]> = [["<own>", true], ["<own>", false], ["http://evil.example", true], ["", true], ["null", true]]
    const wrong = (["loopback", "tailnet"] as const).flatMap((listener) =>
      ADDRESSES.flatMap(([address, who]) =>
        POLICIES.flatMap((policy) => ROUTE_KINDS.flatMap((kind) => [true, false].flatMap((paired) => ORIGINS.flatMap(([origin, pageHeader]) => Option.toArray(check(listener, address, who, policy, kind, paired, origin, pageHeader)))))),
      ),
    )
    expect(wrong.slice(0, 5)).toEqual([])
  })
})

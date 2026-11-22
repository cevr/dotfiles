// The page's policy as a model: every combination of listener, route, paired, origin, host, headers and
// `digest.tailnetRead`, checked against the rules it must keep. Addresses and names are invented.
import { describe, expect, test } from "bun:test"
import { Match } from "effect"
import { ACCESS, type Decision, decide, type Facts, type Listener, ROUTE_KINDS, type RouteKind, type TailnetRead, WRITES } from "./policy.ts"

const LOOPBACK_HOSTS = ["127.0.0.1:8240", "localhost:8240"]
const TAILNET_HOSTS = ["100.101.102.103:8240", "[fd7a:115c:a1e0::42]:8240", "harbor.example-tailnet.ts.net:8240", "harbor:8240"]
const HOSTS_OF: Readonly<Record<Listener, ReadonlyArray<string>>> = { loopback: LOOPBACK_HOSTS, tailnet: TAILNET_HOSTS }
const hostsOf = (listener: Listener) => HOSTS_OF[listener]

/** The hosts a request may name: each of the listener's own, the other listener's, a rebound name, none. */
const HOSTS = [...LOOPBACK_HOSTS, ...TAILNET_HOSTS, "evil.example:8240", "100.101.102.103:9999", ""]
/** The kinds that answer with the page's data (the view, the marks it changes, an answer, the health line's counts). */
const DATA: ReadonlyArray<RouteKind> = ["read", "mark", "answer", "health"]

/** Every combination, with the origin as the request's own, another of the listener's names, a foreign one, or none. */
const combinations = (): ReadonlyArray<{ readonly facts: Facts; readonly tailnetRead: TailnetRead }> =>
  (["loopback", "tailnet"] as const).flatMap((listener) =>
    ROUTE_KINDS.flatMap((kind) =>
      HOSTS.flatMap((host) =>
        [`http://${host}`, `http://${hostsOf(listener).find((each) => each !== host) ?? ""}`, "http://evil.example", ""].flatMap((origin) =>
          [true, false].flatMap((paired) =>
            [true, false].flatMap((pageHeader) =>
              [true, false].flatMap((json) =>
                (["paired", "member"] as const).map((tailnetRead) => ({ facts: { listener, kind, host, hosts: hostsOf(listener), origin, pageHeader, json, paired }, tailnetRead })),
              ),
            ),
          ),
        ),
      ),
    ),
  )

const status = (decision: Decision): number | string => Match.valueTags(decision, { Refuse: (refused) => refused.status, Serve: () => "Serve", Brief: () => "Brief" })

describe("the page's policy, at every combination", () => {
  const all = combinations()

  test(`no route answers a Host that is not one of its listener's own (${all.length} combinations)`, () => {
    const answered = all.filter(({ facts, tailnetRead }) => !facts.hosts.includes(facts.host) && status(decide(facts, tailnetRead)) !== 421)
    expect(answered).toEqual([])
  })

  test("on the tailnet, an unpaired request gets no data from any route, unless his switch opens the reads to members", () => {
    const leaked = all.filter(({ facts, tailnetRead }) => {
      const decision = decide(facts, tailnetRead)
      const opened = facts.kind === "read" && tailnetRead === "member"
      return facts.listener === "tailnet" && !facts.paired && DATA.includes(facts.kind) && !opened && decision._tag === "Serve"
    })
    expect(leaked).toEqual([])
  })

  test("the health line on the tailnet unpaired is `ok` alone (Brief); paired, or on loopback, the whole line", () => {
    const health = all.filter(({ facts }) => facts.kind === "health" && facts.hosts.includes(facts.host))
    for (const { facts, tailnetRead } of health) expect([facts.listener, facts.paired, String(decide(facts, tailnetRead)._tag)]).toEqual([facts.listener, facts.paired, String(["Serve", "Brief"][Number(facts.listener === "tailnet" && !facts.paired)])])
  })

  test("no write is served from another origin than the Host it named, without the page's header, or not JSON", () => {
    const served = all.filter(({ facts, tailnetRead }) => WRITES.includes(facts.kind) && (facts.origin !== `http://${facts.host}` || !facts.pageHeader || !facts.json) && decide(facts, tailnetRead)._tag !== "Refuse")
    expect(served).toEqual([])
  })

  test("everything else is served exactly as ACCESS says: open, or paired", () => {
    const wrong = all.filter(({ facts, tailnetRead }) => {
      const valid = facts.hosts.includes(facts.host) && (!WRITES.includes(facts.kind) || (facts.origin === `http://${facts.host}` && facts.pageHeader && facts.json))
      if (!valid) return false
      const opened = facts.listener === "tailnet" && facts.kind === "read" && tailnetRead === "member"
      const need = [ACCESS[facts.listener][facts.kind], "open"][Number(opened)]
      const expected = Match.value({ served: need === "open" || facts.paired, need }).pipe(
        Match.when({ served: true }, (): number | string => "Serve"),
        Match.when({ need: "brief" }, () => "Brief"),
        Match.orElse(() => 401),
      )
      return status(decide(facts, tailnetRead)) !== expected
    })
    expect(wrong).toEqual([])
  })

  test("the table itself: loopback reads and marks open, answers paired; the tailnet all paired but the shell, status, pairing and health's ok", () => {
    expect(ACCESS).toEqual({
      loopback: { shell: "open", status: "open", health: "open", read: "open", mark: "open", answer: "paired", pair: "open" },
      tailnet: { shell: "open", status: "open", health: "brief", read: "paired", mark: "paired", answer: "paired", pair: "open" },
    })
    // His switch: members read on the tailnet, and nothing else changes.
    const base = { host: "harbor:8240", hosts: TAILNET_HOSTS, origin: "http://harbor:8240", pageHeader: true, json: true, paired: false } as const
    expect(ROUTE_KINDS.map((kind) => [kind, status(decide({ ...base, listener: "tailnet", kind }, "member"))])).toEqual([
      ["shell", "Serve"],
      ["status", "Serve"],
      ["health", "Brief"],
      ["read", "Serve"],
      ["mark", 401],
      ["answer", 401],
      ["pair", "Serve"],
    ])
  })
})

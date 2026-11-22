// An agent host and an excluded device can only restrict, never admit (round 1's B1). Being named in
// `digest.agentHosts` narrows what one of HIS devices may do, and `digest.excludedDevices` takes one of his devices
// out altogether; neither ever makes another user's device his. Over generated tailnets (devices of several users with
// colliding HostNames, MagicDNS names and stable IDs, tags, shares, missing users, names and IDs, an address listed
// twice):
// - monotonic: whatever a request is allowed with agentHosts = X and excluded = E, it is allowed with agentHosts = []
//   (same E), and with excluded = [] (same X);
// - only his: a source is `own` or `agent` only if its address is one of his devices' (this host's or a peer of his
//   Tailscale user, not tagged, not shared in, not excluded by ID or MagicDNS name), and listed by no other device;
// - an agent-host name that none of his devices carries as its MagicDNS name closes tokenless writes, whatever other
//   users' devices call themselves;
// - an exclusion whose ID none of his devices has is named in health (`unmatched:`), one without an ID too (`unkeyed:`).
// The verifier's four cases (round 1, B1) and the excluded device go through the real listener in
// http/listener.test.ts. Users, names, IDs and addresses are invented.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { canonicalOf, type PeerStatus, StatusRead, type TailscaleStatus } from "./bind.ts"
import { type Exclusion, exclusionsFrom, type Members, membersOf, sourceOf } from "./members.ts"
import { decide, type Facts, type Policy, ROUTE_KINDS, TAILNET_WRITES } from "./policy.ts"

const NOW = 1_795_204_800_000
const HIS = 7

// A small seeded generator: the property runs the same cases on every run.
const generator = (seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  return {
    pick: <A>(all: ReadonlyArray<A>): A => Option.getOrThrow(Option.fromUndefinedOr(all[Math.floor(next() * all.length)])),
    some: <A>(all: ReadonlyArray<A>): ReadonlyArray<A> => all.filter(() => next() < 0.3),
    chance: (p: number) => next() < p,
  }
}
type Random = ReturnType<typeof generator>

const NAMES = ["skiff", "harbor", "bite-cristian", "devbox", "skiff-1", "SKIFF", ""]
const ADDRESSES = ["100.101.102.103", "100.101.102.104", "100.101.102.110", "100.101.102.120", "100.101.102.121", "fd7a:115c:a1e0::104", "fd7a:115c:a1e0::120", "100.127.0.9"]
const SPELLINGS = (address: string): ReadonlyArray<string> => [address, ...Option.toArray(Option.liftPredicate(`::ffff:${address}`, () => !address.includes(":"))), address.toUpperCase()]

const IDS = ["nSkiff1CNTRL", "nDinghy1CNTRL", "nRaft1CNTRL"]

const nodeOf = (random: Random): PeerStatus => ({
  dnsName: Option.filter(Option.some(`${random.pick(NAMES)}.example-tailnet.ts.net`), () => random.chance(0.85)),
  stableId: Option.filter(Option.some(random.pick(IDS)), () => random.chance(0.85)),
  hostName: random.pick(NAMES),
  ips: random.some(ADDRESSES),
  userId: Option.filter(Option.some(random.pick([HIS, HIS, 9, 11])), () => random.chance(0.9)),
  tagged: random.chance(0.15),
  shared: random.chance(0.1),
})

const statusOf = (random: Random): TailscaleStatus => ({
  backendState: "Running",
  dnsName: Option.filter(Option.some(`${random.pick(NAMES)}.example-tailnet.ts.net`), () => random.chance(0.9)),
  ips: random.some(ADDRESSES),
  userId: Option.filter(Option.some(HIS), () => random.chance(0.9)),
  tagged: random.chance(0.1),
  peers: Array.from({ length: 1 + random.pick([2, 4]) }, () => nodeOf(random)),
})

const spelling = (address: string) => Option.getOrElse(canonicalOf(address), () => address)

/** A MagicDNS name's spellings an entry may use: whole and its first label, lower case. */
const dnsSpellings = (name: Option.Option<string>): ReadonlyArray<string> =>
  Option.toArray(name).flatMap((each) => [each.toLowerCase(), (each.split(".")[0] ?? "").toLowerCase()]).filter((each) => each !== "" && !each.startsWith("."))

/** The reference, written apart from members.ts: same user first (not tagged, not shared, his UserID), then not excluded. */
const reference = (status: TailscaleStatus, excluded: ReadonlyArray<Exclusion>) => {
  const selfHis = !status.tagged && Option.isSome(status.userId)
  const sameUser = (peer: PeerStatus) => selfHis && !peer.tagged && !peer.shared && Option.isSome(peer.userId) && Option.getOrUndefined(peer.userId) === Option.getOrUndefined(status.userId)
  const isExcluded = (peer: PeerStatus) =>
    excluded.some((each) => each.ids.some((id) => Option.contains(peer.stableId, id)) || dnsSpellings(peer.dnsName).includes(each.name.toLowerCase()))
  // An unkeyed exclusion cannot be applied: nothing is his until it has an ID.
  const keyed = excluded.every((each) => each.ids.length > 0)
  const peerHis = (peer: PeerStatus) => keyed && sameUser(peer) && !isExcluded(peer)
  const his = [...status.ips.filter(() => selfHis && keyed), ...status.peers.filter(peerHis).flatMap((peer) => peer.ips)].map(spelling)
  const theirs = new Set(status.peers.filter((peer) => !peerHis(peer)).flatMap((peer) => peer.ips).map(spelling))
  return {
    addresses: new Set(his.filter((each) => !theirs.has(each))),
    names: new Set([...dnsSpellings(status.dnsName).filter(() => selfHis), ...status.peers.filter(peerHis).flatMap((peer) => dnsSpellings(peer.dnsName))]),
    ids: new Set(status.peers.filter(sameUser).flatMap((peer) => Option.toArray(peer.stableId))),
  }
}

const served = (facts: Facts, policy: Policy) => decide(facts, policy)._tag === "Serve"

const exclusionOf = (random: Random): Exclusion => ({ name: random.pick(NAMES.filter((each) => each !== "")), ids: random.some([...IDS, "nGone1CNTRL"]) })

describe("an agent host or an exclusion only restricts, over generated tailnets", () => {
  const random = generator(20_261_122)
  const cases = Array.from({ length: 300 }, () => ({
    status: statusOf(random),
    agentHosts: random.some([...NAMES.filter((each) => each !== ""), ...ADDRESSES]),
    excluded: Array.from({ length: random.pick([0, 1, 1, 2]) }, () => exclusionOf(random)),
  }))

  test(
    "monotonic: allowed with agentHosts = X and excluded = E implies allowed with agentHosts = [], and with excluded = [], for every source, switch, route and token",
    () => {
      const requests = ADDRESSES.flatMap(SPELLINGS).flatMap((address) => ROUTE_KINDS.flatMap((kind) => [false, true].map((paired) => ({ address, kind, paired }))))
      const wrong = cases.flatMap(({ status, agentHosts, excluded }) =>
        TAILNET_WRITES.flatMap((tailnetWrite) =>
          (["paired", "member"] as const).flatMap((tailnetRead) => {
            const at = (config: { agentHosts: ReadonlyArray<string>; excluded: ReadonlyArray<Exclusion> }) => membersOf({ tailnetWrite, ...config }, StatusRead.Read({ status }), NOW)
            const narrower = { both: at({ agentHosts, excluded }), noHosts: at({ agentHosts: [], excluded }), noExclusions: at({ agentHosts, excluded: [] }) }
            return requests.flatMap(({ address, kind, paired }) => {
              const allowed = (members: Members) =>
                served({ listener: "tailnet", kind, source: sourceOf(address, members), host: "harbor:8240", hosts: ["harbor:8240"], origin: "http://harbor:8240", pageHeader: true, json: true, paired }, { tailnetRead, tailnetWrite: members.write })
              const broken = [
                ["agentHosts", narrower.noHosts],
                ["excluded", narrower.noExclusions],
              ] as const
              return broken.flatMap(([by, without]) => [{ by, agentHosts, excluded, address, kind, paired, tailnetRead, tailnetWrite }].filter(() => allowed(narrower.both) && !allowed(without)))
            })
          }),
        ),
      )
      expect(wrong.slice(0, 3)).toEqual([])
    },
    30_000,
  )

  test("only his: a source is own or agent only if its address is one of his devices' (not excluded) and no other device lists it", () => {
    const wrong = cases.flatMap(({ status, agentHosts, excluded }) => {
      const members = membersOf({ tailnetWrite: "member", agentHosts, excluded }, StatusRead.Read({ status }), NOW)
      const his = reference(status, excluded).addresses
      return ADDRESSES.flatMap(SPELLINGS).flatMap((address) => [{ agentHosts, excluded, address, source: sourceOf(address, members) }].filter((each) => (each.source === "own" || each.source === "agent") && !his.has(spelling(address))))
    })
    expect(wrong.slice(0, 3)).toEqual([])
  })

  test("a named agent host none of his devices carries as its MagicDNS name closes the tokenless writes, whatever others call themselves", () => {
    const wrong = cases.flatMap(({ status, agentHosts, excluded }) => {
      const members = membersOf({ tailnetWrite: "member-except-hosts", agentHosts, excluded }, StatusRead.Read({ status }), NOW)
      const his = reference(status, excluded)
      const missing = agentHosts.filter((entry) => Option.match(canonicalOf(entry), { onSome: (address) => !his.addresses.has(address), onNone: () => !his.names.has(entry.toLowerCase()) }))
      return [{ agentHosts, missing, write: members.write, why: members.why }].filter((each) => each.missing.length > 0 && (each.write !== "paired" || !/^(unresolved|unkeyed):/.test(each.why)))
    })
    expect(wrong.slice(0, 3)).toEqual([])
  })

  test("an unkeyed exclusion closes every switch (health names it); a keyed one none of whose IDs his devices have is named unmatched", () => {
    const wrong = cases.flatMap(({ status, excluded }) => {
      const members = membersOf({ tailnetWrite: "member", agentHosts: [], excluded }, StatusRead.Read({ status }), NOW)
      const ids = reference(status, excluded).ids
      const unkeyed = excluded.filter((each) => each.ids.length === 0)
      const named = excluded.flatMap((each) => [`unmatched:${each.name}`].filter(() => !each.ids.some((id) => ids.has(id))))
      const closedRight = unkeyed.length === 0 || (members.write === "paired" && members.why === `unkeyed:${unkeyed[0]?.name ?? ""}` && members.own.length + members.agents.length === 0)
      const namedRight = unkeyed.length > 0 || (named.every((part) => members.excluded.includes(part)) && (named.length > 0 || !members.excluded.includes(":")))
      return [{ excluded, word: members.excluded, why: members.why, named }].filter(() => !closedRight || !namedRight)
    })
    expect(wrong.slice(0, 3)).toEqual([])
  })
})


// ── Exclusions over time (round 2's B1): renames, re-keys, removals, another user's device taking the name, configures ──

/** One of his devices that is excluded by name ("dinghy"), as it changes; a colleague's device that may take the name. */
interface World {
  readonly dinghy: { readonly present: boolean; readonly name: string; readonly id: string }
  readonly colleague: Option.Option<string>
}
const DINGHY_IP = "100.101.102.130"

const worldStatus = (world: World): TailscaleStatus => ({
  backendState: "Running",
  dnsName: Option.some("harbor.example-tailnet.ts.net"),
  ips: ["100.101.102.103"],
  userId: Option.some(HIS),
  tagged: false,
  peers: [
    { dnsName: Option.some("phone.example-tailnet.ts.net"), stableId: Option.some("nPhone"), hostName: "localhost", ips: ["100.101.102.110"], userId: Option.some(HIS), tagged: false, shared: false },
    ...[{ dnsName: Option.some(`${world.dinghy.name}.example-tailnet.ts.net`), stableId: Option.some(world.dinghy.id), hostName: world.dinghy.name, ips: [DINGHY_IP], userId: Option.some(HIS), tagged: false, shared: false }].filter(() => world.dinghy.present),
    ...Option.toArray(world.colleague).map((name) => ({ dnsName: Option.some(`${name}.example-tailnet.ts.net`), stableId: Option.some("nTheirs"), hostName: name, ips: ["100.101.102.120"], userId: Option.some(9), tagged: false, shared: false })),
  ],
})

type Step = "rename" | "rekey" | "remove" | "readd" | "colleague" | "configure" | "configure-unread" | "request"
const STEPS: ReadonlyArray<Step> = ["rename", "rekey", "remove", "readd", "colleague", "configure", "configure", "configure-unread", "request", "request"]

/** The world after `step`; the n-th re-key gives the device a new stable ID. */
const changed = (world: World, step: Step, random: Random, n: number): World =>
  ({
    rename: { ...world, dinghy: { ...world.dinghy, name: random.pick(["lifeboat", "raft", "dinghy-2", "dinghy"]) } },
    rekey: { ...world, dinghy: { ...world.dinghy, id: `nDinghy${n}` } },
    remove: { ...world, dinghy: { ...world.dinghy, present: false } },
    readd: { ...world, dinghy: { ...world.dinghy, present: true } },
    colleague: { ...world, colleague: Option.some(random.pick(["dinghy", "dinghy-1", "lifeboat"])) },
    configure: world,
    "configure-unread": world,
    request: world,
  })[step]

describe("an exclusion over time: renames, re-keys, removals, another user's device taking its name, configures", () => {
  test("a device ever keyed as excluded is never admitted unpaired, no configure unkeys an exclusion or drops an ID, and no other user's ID is ever shipped", () => {
    const random = generator(20_261_123)
    const wrong: Array<unknown> = []
    for (const run of Array.from({ length: 400 }, (_, index) => index)) {
      let world: World = { dinghy: { present: true, name: "dinghy", id: "nDinghy0" }, colleague: Option.none() }
      // Nothing shipped yet (no state file): the first configure may well have no status.
      let shipped: Option.Option<ReadonlyArray<Exclusion>> = Option.none()
      const everKeyed = new Set<string>()
      const steps = Array.from({ length: 12 }, () => random.pick(STEPS))
      steps.forEach((step, n) => {
        world = changed(world, step, random, n + 1)
        const status = StatusRead.Read({ status: worldStatus(world) })
        if (step === "configure" || step === "configure-unread") {
          const before = Option.getOrElse(shipped, () => [])
          const read = { configure: status, "configure-unread": StatusRead.Unread({ why: "cli-failed" }) }[step]
          const next = exclusionsFrom(before, ["dinghy"], read)
          const lost = before.flatMap((each) => each.ids).filter((id) => !next.some((entry) => entry.ids.includes(id)))
          if (lost.length > 0) wrong.push({ run, steps, n, lost })
          if (next.some((entry) => entry.ids.includes("nTheirs"))) wrong.push({ run, steps, n, theirs: next })
          next.forEach((entry) => entry.ids.forEach((id) => everKeyed.add(id)))
          shipped = Option.some(next)
        }
        // Once a configure shipped it, every request is checked: the device keyed (or still named) never gets in unpaired.
        Option.map(shipped, (excluded) => {
          const members = membersOf({ tailnetWrite: "member", agentHosts: [], excluded }, status, NOW)
          const keyedNow = world.dinghy.present && (everKeyed.has(world.dinghy.id) || world.dinghy.name === "dinghy")
          const admitted = ROUTE_KINDS.filter((kind) =>
            served({ listener: "tailnet", kind, source: sourceOf(DINGHY_IP, members), host: "harbor:8240", hosts: ["harbor:8240"], origin: "http://harbor:8240", pageHeader: true, json: true, paired: false }, { tailnetRead: "member", tailnetWrite: members.write }),
          ).filter((kind) => ["read", "mark", "answer"].includes(kind))
          if (keyedNow && admitted.length > 0) wrong.push({ run, steps, n, world, excluded, admitted })
          return members
        })
      })
    }
    expect(wrong.slice(0, 3)).toEqual([])
  })
})

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
// http/listener.test.ts; the store's keys over time (renames, re-keys, the store lost) in filestore/devices.test.ts. Users, names, IDs and addresses are invented.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { canonicalOf, type PeerStatus, StatusRead, type TailscaleStatus } from "./bind.ts"
import { type Exclusion, type Members, membersOf, sourceOf } from "./members.ts"
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
  os: "", lastSeen: Option.none(), hostName: random.pick(NAMES),
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
                served({ listener: "tailnet", kind, source: sourceOf(address, members), host: Option.some("100.101.102.103:8240"), hosts: ["100.101.102.103:8240"], names: ["harbor:8240"], root: false, origin: Option.some("http://100.101.102.103:8240"), pageHeader: true, json: true, paired }, { tailnetRead, tailnetWrite: members.write })
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


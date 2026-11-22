// The device store's decision table (devices.ts keysOf), exhaustively: every condition of each of the two copies,
// against every set of names the config gives. Checked against a reference written apart from devices.ts:
// - an excluded name with no ID in any readable copy closes every tailnet source, and says the store's condition;
// - an agent name with no ID closes the writes;
// - the IDs a name gets are the union of the readable copies' (a second copy only restricts more);
// - health names a copy that is not read, and copies that disagree;
// - nothing is looked up: the keys depend on the copies and the names alone.
// The store over time, on disk (renames, re-keys, the store lost in every form), is filestore/devices.test.ts.
import { describe, expect, test } from "bun:test"
import { Match, Option } from "effect"
import { type PeerStatus, StatusRead } from "./bind.ts"
import { addedTo, Copy, copyOfText, copyWord, EMPTY_STORE, keysOf, type Named, nameKey, refusalOf, type Store, storeToEdit, withId, withoutName } from "./devices.ts"

const store = (excluded: ReadonlyArray<readonly [string, ReadonlyArray<string>]>, agents: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = []): Store => ({
  ...EMPTY_STORE,
  excluded: excluded.map(([name, ids]) => ({ name, ids })),
  agents: agents.map(([name, ids]) => ({ name, ids })),
})

/** Every condition a copy can be in, by what reading it gives. */
const COPIES: ReadonlyArray<readonly [string, Copy]> = [
  ["absent", Copy.Absent()],
  ["unreadable-EACCES", Copy.Unreadable({ why: "EACCES" })],
  ["unreadable-EISDIR", Copy.Unreadable({ why: "EISDIR" })],
  ["unparsable", Copy.Invalid({ why: "unparsable" })],
  ["wrong-version", Copy.Invalid({ why: "wrong-version" })],
  ["wrong-shape", Copy.Invalid({ why: "wrong-shape" })],
  ["ok", Copy.Read({ store: EMPTY_STORE })],
  ["ok", Copy.Read({ store: store([["raft", ["nRaft1"]]]) })],
  ["ok", Copy.Read({ store: store([["dinghy", ["nDinghy1"]]], [["skiff", ["nSkiff1"]]]) })],
  ["ok", Copy.Read({ store: store([["DINGHY", ["nDinghy2"]]]) })],
  ["ok", Copy.Read({ store: store([["dinghy", []]], [["skiff", []]]) })],
  ["ok", Copy.Read({ store: store([["dinghy", ["nDinghy1", "nDinghy2"]]], [["skiff", ["nSkiff1"]]]) })],
]

const NAMED: ReadonlyArray<Named> = [
  { agentHosts: [], excluded: [] },
  { agentHosts: [], excluded: ["dinghy"] },
  { agentHosts: ["skiff"], excluded: [] },
  { agentHosts: ["skiff"], excluded: ["dinghy"] },
  { agentHosts: ["skiff"], excluded: ["dinghy", "raft"] },
]

/** The reference: what each name's IDs, and what closes, from the copies, without devices.ts's helpers. */
const reference = (named: Named, copies: ReadonlyArray<readonly [string, Copy]>) => {
  const stores = copies.flatMap(([, copy]) => Match.valueTags(copy, { Read: ({ store: each }) => [each], Absent: () => [], Unreadable: () => [], Invalid: () => [] }))
  const ids = (kind: "agents" | "excluded", name: string) => {
    const all = stores.flatMap((each) => each[kind]).filter((entry) => entry.name.toLowerCase() === name.toLowerCase()).flatMap((entry) => entry.ids)
    return all.filter((id, index) => all.indexOf(id) === index)
  }
  const condition = `store-${copies.map(([word]) => word).join("/")}`
  const allUnkeyed = (kind: "agents" | "excluded", names: ReadonlyArray<string>) => Option.liftPredicate(names.filter((name) => ids(kind, name).length === 0).join(","), (list) => list !== "")
  const print = (each: Store) => (["agents", "excluded"] as const).flatMap((kind) => each[kind].flatMap((entry) => entry.ids.map((id) => `${kind}/${entry.name.toLowerCase()}/${id}`))).toSorted().join(" ")
  const differ = stores.length === 2 && new Set(stores.map(print)).size === 2
  const unkeyed = allUnkeyed("excluded", named.excluded)
  const agentUnkeyed = allUnkeyed("agents", named.agentHosts)
  return {
    excluded: named.excluded.map((name) => ({ name, ids: ids("excluded", name) })),
    agents: named.agentHosts.map((name) => ({ name, ids: ids("agents", name) })),
    closeAll: Option.map(unkeyed, (names) => `unkeyed:${names}${Option.getOrElse(Option.map(agentUnkeyed, (agents) => `:agent-unkeyed:${agents}`), () => "")}:${condition}`),
    closeWrites: Option.map(agentUnkeyed, (name) => `agent-unkeyed:${name}:${condition}`),
    note: Option.orElse(Option.liftPredicate(condition, (each) => each !== "store-ok/ok"), () => Option.liftPredicate("store-copies-differ", () => differ)),
  }
}

describe("the device store's decision table", () => {
  test("every pair of copy conditions, against every set of names: the keys are the reference's, exactly", () => {
    const rows = NAMED.flatMap((named) => COPIES.flatMap((primary) => COPIES.map((secondary) => ({ named, primary, secondary }))))
    expect(rows.length).toBe(NAMED.length * COPIES.length * COPIES.length)
    const wrong = rows.filter(({ named, primary, secondary }) => !Bun.deepEquals(keysOf(named, primary[1], secondary[1]), reference(named, [primary, secondary])))
    expect(wrong.slice(0, 3).map(({ named, primary, secondary }) => ({ named, primary, secondary, got: keysOf(named, primary[1], secondary[1]) }))).toEqual([])
  })

  test("an excluded name no readable copy keys closes everything, whatever the other copy says; a name either copy keys does not", () => {
    const lost = COPIES.flatMap(([, copy]) => [copy].filter((each) => each._tag !== "Read"))
    const named = { agentHosts: [], excluded: ["dinghy"] }
    for (const primary of lost)
      for (const secondary of lost) expect(Option.getOrElse(keysOf(named, primary, secondary).closeAll, () => "open")).toStartWith("unkeyed:dinghy:store-")
    const keyed = Copy.Read({ store: store([["dinghy", ["nDinghy1"]]]) })
    for (const other of lost) {
      expect([keysOf(named, keyed, other).closeAll, keysOf(named, other, keyed).closeAll]).toEqual([Option.none(), Option.none()])
      expect(keysOf(named, keyed, other).excluded).toEqual([{ name: "dinghy", ids: ["nDinghy1"] }])
    }
  })

  test("health names every name nothing keys at once (the whole delivery left to do), excluded and agents", () => {
    const named = { agentHosts: ["bite-cristian", "cristians-macbook-pro-rex"], excluded: ["lenovo-rescue", "raft"] }
    expect(keysOf(named, Copy.Absent(), Copy.Absent()).closeAll).toEqual(Option.some("unkeyed:lenovo-rescue,raft:agent-unkeyed:bite-cristian,cristians-macbook-pro-rex:store-absent/absent"))
    const partly = Copy.Read({ store: store([["lenovo-rescue", ["nL1"]], ["raft", ["nRaft1"]]], [["cristians-macbook-pro-rex", ["nRex1"]]]) })
    expect([keysOf(named, partly, partly).closeAll, keysOf(named, partly, partly).closeWrites]).toEqual([Option.none(), Option.some("agent-unkeyed:bite-cristian:store-ok/ok")])
  })

  test("a store entry keys its shipped name by first label, any case: a full MagicDNS name matches the installer's short one", () => {
    const full = Copy.Read({ store: store([["Lenovo-Rescue.example-tailnet.ts.net.", ["nL1"]]]) })
    expect(keysOf({ agentHosts: [], excluded: ["lenovo-rescue"] }, full, Copy.Absent()).excluded).toEqual([{ name: "lenovo-rescue", ids: ["nL1"] }])
    expect([nameKey("lenovo-rescue.example-tailnet.ts.net."), nameKey("REX"), nameKey("")]).toEqual(["lenovo-rescue", "rex", ""])
  })

  test("two copies that disagree: the union of IDs, and health says so", () => {
    const keys = keysOf({ agentHosts: [], excluded: ["dinghy"] }, Copy.Read({ store: store([["dinghy", ["nDinghy1"]]]) }), Copy.Read({ store: store([["dinghy", ["nDinghy2"]]]) }))
    expect([keys.excluded, keys.note, keys.closeAll]).toEqual([[{ name: "dinghy", ids: ["nDinghy1", "nDinghy2"] }], Option.some("store-copies-differ"), Option.none()])
  })

  test("a copy's text: a store of this version and shape reads, anything else is named and keys nothing", () => {
    const good = '{"v":1,"agents":[{"name":"skiff","ids":["nSkiff1"]}],"excluded":[{"name":"dinghy","ids":["nDinghy1"]}]}'
    expect(copyOfText(good)).toEqual(Copy.Read({ store: store([["dinghy", ["nDinghy1"]]], [["skiff", ["nSkiff1"]]]) }))
    const texts = ["", "{", good.slice(0, 30), "\u0000garbage", "null", "[]", '[{"name":"dinghy","id":"nDinghy1"}]', '{"v":2,"agents":[],"excluded":[]}', '{"v":1,"excluded":[]}', '{"v":1,"agents":[],"excluded":[{"name":"dinghy","ids":[""]}]}', '{"v":1,"agents":[],"excluded":[{"name":"","ids":["x"]}]}']
    expect(texts.map((text) => copyWord(copyOfText(text)))).toEqual(["unparsable", "unparsable", "unparsable", "unparsable", "wrong-version", "wrong-version", "wrong-version", "wrong-version", "wrong-shape", "wrong-shape", "wrong-shape"])
  })
})

describe("the command's edits", () => {
  test("the store's invariant: an added ID must be, in the status read now, a device of his own user; nothing added needs no status", () => {
    const peer = (id: string, user: number, extra: Partial<PeerStatus> = {}): PeerStatus => ({ dnsName: Option.some(`${id}.example-tailnet.ts.net`), stableId: Option.some(id), os: "linux", lastSeen: Option.none(), hostName: id, ips: [], userId: Option.some(user), tagged: false, shared: false, ...extra })
    const status = (state: string) => StatusRead.Read({ status: { backendState: state, dnsName: Option.some("harbor.example-tailnet.ts.net"), ips: [], userId: Option.some(7), tagged: false, peers: [peer("nL1", 7), peer("nTheirs", 9), peer("nTagged", 7, { tagged: true }), peer("nShared", 7, { shared: true })] } })
    const adding = (id: string) => addedTo(EMPTY_STORE, withId(EMPTY_STORE, "excluded", "lenovo-rescue", id))
    expect(adding("nL1")).toEqual([{ kind: "excluded", name: "lenovo-rescue", id: "nL1" }])
    expect(refusalOf(adding("nL1"), status("Running"))).toEqual(Option.none())
    for (const id of ["nL1typo", "nTheirs", "nTagged", "nShared"]) expect([id, Option.isSome(refusalOf(adding(id), status("Running")))]).toEqual([id, true])
    expect([refusalOf(adding("nL1"), StatusRead.Unread({ why: "no-cli" })), refusalOf(adding("nL1"), status("Stopped"))].map(Option.isSome)).toEqual([true, true])
    // A rerun or a removal adds nothing, and is never refused for want of a status.
    const keyed = withId(EMPTY_STORE, "excluded", "lenovo-rescue", "nL1")
    expect([addedTo(keyed, keyed), addedTo(keyed, withoutName(keyed, "excluded", "lenovo-rescue"))]).toEqual([[], []])
    expect(refusalOf([], StatusRead.Unread({ why: "no-cli" }))).toEqual(Option.none())
    // The same ID under another name or kind is an addition, checked like any other.
    expect(addedTo(keyed, withId(keyed, "agents", "rex", "nL1"))).toEqual([{ kind: "agents", name: "rex", id: "nL1" }])
  })

  test("it starts from the union of the readable copies, and refuses when a copy exists but none reads", () => {
    const one = Copy.Read({ store: store([["dinghy", ["nDinghy1"]]]) })
    const two = Copy.Read({ store: store([["dinghy", ["nDinghy2"]]], [["skiff", ["nSkiff1"]]]) })
    expect(storeToEdit(one, two)).toEqual(Option.some(store([["dinghy", ["nDinghy1", "nDinghy2"]]], [["skiff", ["nSkiff1"]]])))
    expect(storeToEdit(Copy.Absent(), Copy.Absent())).toEqual(Option.some(EMPTY_STORE))
    expect(storeToEdit(Copy.Invalid({ why: "unparsable" }), one)).toEqual(Option.some(store([["dinghy", ["nDinghy1"]]])))
    expect([storeToEdit(Copy.Invalid({ why: "unparsable" }), Copy.Absent()), storeToEdit(Copy.Absent(), Copy.Unreadable({ why: "EACCES" }))]).toEqual([Option.none(), Option.none()])
  })

  test("adding an ID keeps every other; forgetting is by name and explicit", () => {
    const keyed = withId(withId(EMPTY_STORE, "excluded", "Dinghy", "nDinghy1"), "excluded", "dinghy", "nDinghy2")
    expect(keyed).toEqual(store([["dinghy", ["nDinghy1", "nDinghy2"]]]))
    expect(withId(keyed, "excluded", "dinghy", "nDinghy1")).toEqual(keyed)
    expect(withId(keyed, "agents", "skiff", "nSkiff1")).toEqual(store([["dinghy", ["nDinghy1", "nDinghy2"]]], [["skiff", ["nSkiff1"]]]))
    expect([withoutName(keyed, "excluded", "DINGHY"), withoutName(keyed, "agents", "dinghy")]).toEqual([EMPTY_STORE, keyed])
  })
})

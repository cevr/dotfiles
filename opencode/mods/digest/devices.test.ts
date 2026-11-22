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
import { Copy, copyOfText, copyWord, EMPTY_STORE, keysOf, type Named, type Store, storeToEdit, withId, withoutName } from "./devices.ts"

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
  const firstUnkeyed = (kind: "agents" | "excluded", names: ReadonlyArray<string>) => Option.fromUndefinedOr(names.find((name) => ids(kind, name).length === 0))
  const print = (each: Store) => (["agents", "excluded"] as const).flatMap((kind) => each[kind].flatMap((entry) => entry.ids.map((id) => `${kind}/${entry.name.toLowerCase()}/${id}`))).toSorted().join(" ")
  const differ = stores.length === 2 && new Set(stores.map(print)).size === 2
  const unkeyed = firstUnkeyed("excluded", named.excluded)
  const agentUnkeyed = firstUnkeyed("agents", named.agentHosts)
  return {
    excluded: named.excluded.map((name) => ({ name, ids: ids("excluded", name) })),
    agents: named.agentHosts.map((name) => ({ name, ids: ids("agents", name) })),
    closeAll: Option.map(unkeyed, (name) => `unkeyed:${name}:${condition}`),
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

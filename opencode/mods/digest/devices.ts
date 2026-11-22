// The device store: which of his devices are agent machines and which are excluded, by Tailscale stable node ID, as
// one deliberate command put them there (`bun cmd/digest/devices.ts`). Nothing else ever adds, removes or replaces
// an ID: not the installer, not the plugin, not a status read, not a lost file. The config names the devices
// (`digest.agentHosts`, `digest.excludedDevices`); the store keys them.
//
// - Two copies (filestore/devices.ts): beside the log (`<digest dir>/devices.json`, the state tree) and under the
//   config tree (`$XDG_CONFIG_HOME/opencode-digest/devices.json`). Each is `{"v":1,"agents":[...],"excluded":[...]}`,
//   each entry `{name, ids}`. The command writes both, whole, atomically, under one lock.
// - keysOf decides, as one pure function, what the plugin applies from the two copies (DECISIONS below):
//   - the IDs of a name are the union of both copies' (a second copy only ever restricts more);
//   - an excluded name with no ID in any readable copy (store absent, empty, unreadable, unparsable, of another
//     shape or version, or the name not in it) is unkeyed: every tailnet source is closed to "paired", reads and
//     writes, and health says why: `paired:unkeyed:<name>:store-<primary>/<secondary>`;
//   - an agent name with no ID closes the tailnet's writes (`paired:agent-unkeyed:<name>:store-...`);
//   - copies that disagree, or one copy not read, are named in health (`excluded=<n>:store-...`);
//   - it never looks a name up, never fails, never writes.
import { Data, Match, Option, Predicate, Schema } from "effect"
import type { StatusRead } from "./bind.ts"
import { type AgentKey, closed, type Exclusion, type Members, membersOf } from "./members.ts"
import type { TailnetWrite } from "./policy.ts"

/** The store's version: a copy of another is never read as keys, and never written over. */
export const STORE_VERSION = 1

/** One device in the store: its MagicDNS name (as the config names it) and the stable node IDs the command found. */
export const StoreEntry = Schema.Struct({ name: Schema.NonEmptyString, ids: Schema.Array(Schema.NonEmptyString) })
export type StoreEntry = typeof StoreEntry.Type

/** A copy of the store. */
export const Store = Schema.Struct({ v: Schema.Literal(STORE_VERSION), agents: Schema.Array(StoreEntry), excluded: Schema.Array(StoreEntry) })
export type Store = typeof Store.Type

/** An empty store: the command's start when no copy exists. */
export const EMPTY_STORE: Store = { v: STORE_VERSION, agents: [], excluded: [] }

/** What reading one copy gave. */
export type Copy = Data.TaggedEnum<{
  /** No file there. */
  Absent: {}
  /** A file the process cannot read (`why`: its error code, `EACCES`, `EISDIR`, ...). */
  Unreadable: { readonly why: string }
  /** A file read but not a store: `unparsable` (not JSON), `wrong-version`, `wrong-shape`. */
  Invalid: { readonly why: "unparsable" | "wrong-version" | "wrong-shape" }
  Read: { readonly store: Store }
}>
export const Copy = Data.taggedEnum<Copy>()

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeVersion = Schema.decodeUnknownOption(Schema.Struct({ v: Schema.Literal(STORE_VERSION) }))
const decodeStore = Schema.decodeUnknownOption(Store)

/** A copy from its file's text. */
export const copyOfText = (text: string): Copy =>
  Option.match(decodeJson(text), {
    onNone: () => Copy.Invalid({ why: "unparsable" }),
    onSome: (json) =>
      Option.match(decodeVersion(json), {
        onNone: () => Copy.Invalid({ why: "wrong-version" }),
        onSome: () => Option.match(decodeStore(json), { onNone: () => Copy.Invalid({ why: "wrong-shape" }), onSome: (store) => Copy.Read({ store }) }),
      }),
  })

/** A copy's condition, for health: `ok`, `absent`, `unreadable-<code>`, `unparsable`, `wrong-version`, `wrong-shape`. */
export const copyWord = (copy: Copy): string =>
  Match.valueTags(copy, {
    Absent: () => "absent",
    Unreadable: ({ why }) => `unreadable-${why.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`,
    Invalid: ({ why }) => why,
    Read: () => "ok",
  })

/** The names the config gives the store to key. */
export interface Named {
  readonly agentHosts: ReadonlyArray<string>
  readonly excluded: ReadonlyArray<string>
}

/** What the plugin applies from the store. */
export interface Keys {
  readonly agents: ReadonlyArray<AgentKey>
  readonly excluded: ReadonlyArray<Exclusion>
  /** Every tailnet source closed (reads and writes), and why. */
  readonly closeAll: Option.Option<string>
  /** The tailnet's writes closed, and why. */
  readonly closeWrites: Option.Option<string>
  /** The store's condition when it is not two equal, readable copies: for health. */
  readonly note: Option.Option<string>
}

/** A word for health: letters, digits, dots and dashes only. */
const word = (text: string) => text.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 60)

/** The stores the readable copies hold. */
const readable = (copies: ReadonlyArray<Copy>): ReadonlyArray<Store> => copies.flatMap((copy) => Match.valueTags(copy, { Read: ({ store }) => [store], Absent: () => [], Unreadable: () => [], Invalid: () => [] }))

/** Every ID `stores` hold for `name` in `kind`, once each, in order. */
const idsOf = (stores: ReadonlyArray<Store>, kind: "agents" | "excluded", name: string): ReadonlyArray<string> => [
  ...new Set(stores.flatMap((store) => store[kind].filter((entry) => entry.name.toLowerCase() === name.toLowerCase()).flatMap((entry) => entry.ids))),
]

/** A store's IDs per (kind, name), as one comparable text. */
const fingerprint = (store: Store): string =>
  (["agents", "excluded"] as const)
    .flatMap((kind) => store[kind].flatMap((entry) => entry.ids.map((id) => `${kind}/${entry.name.toLowerCase()}/${id}`)))
    .toSorted()
    .join("\n")

/**
 * What the plugin applies from the store's two copies for the names the config gives (DECISIONS). Never a lookup,
 * never a failure: a copy that cannot be read keys nothing, and a name nothing keys closes.
 */
export const keysOf = (named: Named, primary: Copy, secondary: Copy): Keys => {
  const stores = readable([primary, secondary])
  const condition = `store-${copyWord(primary)}/${copyWord(secondary)}`
  const excluded = named.excluded.map((name): Exclusion => ({ name, ids: idsOf(stores, "excluded", name) }))
  const agents = named.agentHosts.map((name): AgentKey => ({ name, ids: idsOf(stores, "agents", name) }))
  const unkeyed = Option.fromUndefinedOr(excluded.find((each) => each.ids.length === 0))
  const agentUnkeyed = Option.fromUndefinedOr(agents.find((each) => each.ids.length === 0))
  const differ = stores.length === 2 && new Set(stores.map(fingerprint)).size > 1
  return {
    agents,
    excluded,
    closeAll: Option.map(unkeyed, (each) => `unkeyed:${word(each.name)}:${condition}`),
    closeWrites: Option.map(agentUnkeyed, (each) => `agent-unkeyed:${word(each.name)}:${condition}`),
    note: Option.orElse(Option.liftPredicate(condition, (each) => each !== "store-ok/ok"), () => Option.liftPredicate("store-copies-differ", () => differ)),
  }
}

/**
 * His devices from a status read, with the store's keys applied (keysOf): unkeyed exclusions close every source,
 * unkeyed agent hosts close the writes, and the store's condition is named in health's `excluded=`.
 */
export const membersWith = (tailnetWrite: TailnetWrite, keys: Keys, read: StatusRead, at: number): Members => {
  const members = membersOf({ tailnetWrite, agentHosts: keys.agents, excluded: keys.excluded }, read, at)
  const noted = { ...members, excluded: [members.excluded, ...Option.toArray(keys.note)].join(":") }
  return Option.match(keys.closeAll, {
    onSome: (why) => ({ ...closed(why, at), excluded: noted.excluded }),
    onNone: () =>
      Option.match(Option.filter(keys.closeWrites, () => members.write !== "paired"), {
        onSome: (why): Members => ({ ...noted, write: "paired", writers: 0, why }),
        onNone: () => noted,
      }),
  })
}

// ── The command's edits: each from the copies read now and one explicit change ──

/** A copy that is there but does not read. */
const isUnread = Predicate.or(Predicate.isTagged("Unreadable"), Predicate.isTagged("Invalid"))

/** The store the command starts from: the union of the readable copies; none when a copy exists but cannot be read. */
export const storeToEdit = (primary: Copy, secondary: Copy): Option.Option<Store> => {
  // A copy that exists but does not read is never written over when neither reads: refused, left for the owner.
  const refused = [primary, secondary].some(isUnread) && readable([primary, secondary]).length === 0
  return Option.liftPredicate(unionOf([primary, secondary]), () => !refused)
}

/** The readable copies as one store: each name once (lower case), with every ID either copy holds for it. */
export const unionOf = (copies: ReadonlyArray<Copy>): Store => {
  const stores = readable(copies)
  const union = (kind: "agents" | "excluded") => [...new Set(stores.flatMap((store) => store[kind].map((entry) => entry.name.toLowerCase())))].map((name) => ({ name, ids: idsOf(stores, kind, name) }))
  return { v: STORE_VERSION, agents: union("agents"), excluded: union("excluded") }
}

/** `store` with `id` added to `name` in `kind` (the entry made when it is new); an ID is never removed this way. */
export const withId = (store: Store, kind: "agents" | "excluded", name: string, id: string): Store => {
  const key = name.toLowerCase()
  const others = store[kind].filter((entry) => entry.name.toLowerCase() !== key)
  return { ...store, [kind]: [...others, { name: key, ids: [...new Set([...idsOf([store], kind, key), id])] }] }
}

/** `store` without `name` in `kind`: the explicit removal. */
export const withoutName = (store: Store, kind: "agents" | "excluded", name: string): Store => ({ ...store, [kind]: store[kind].filter((entry) => entry.name.toLowerCase() !== name.toLowerCase()) })

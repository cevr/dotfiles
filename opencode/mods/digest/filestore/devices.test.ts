// The device store on disk over time (round 3's B1, the property the verifier asked for): generated sequences of
// renames, re-keys, removals, another of HIS devices or another user's device taking a name, configures, requests,
// the owner's explicit command, and the store lost in every form (deleted, emptied, truncated, garbage, mode 000, a
// directory in its place; one copy or both), all on real files read by the plugin's own reader. Invariants:
// - a device ever keyed as excluded is never admitted unpaired (read, mark, answer), and a device ever keyed as an
//   agent host never writes unpaired; another user's device never gets in;
// - no automatic step (a configure, a request, a status read) adds, removes or replaces an ID: the files are byte for
//   byte as they were;
// - every step kind runs at least MIN_EACH times, so the property cannot pass on sequences that never reach one.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Match, Option } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { type PeerStatus, StatusRead, type TailscaleStatus } from "../bind.ts"
import { type Copy, copyOfText, copyWord, keysOf, membersWith, type Store, withId } from "../devices.ts"
import { type Members, sourceOf } from "../members.ts"
import { decide, ROUTE_KINDS, type RouteKind } from "../policy.ts"
import { change, readCopies, readCopy } from "./devices.ts"

const NOW = 1_795_204_800_000
const HIS = 7
const NAMED = { agentHosts: ["skiff"], excluded: ["dinghy"] }

// A small seeded generator: the property runs the same cases on every run.
const generator = (seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  return { pick: <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Option.fromUndefinedOr(all[Math.floor(next() * all.length)])) }
}
type Pick = ReturnType<typeof generator>["pick"]

/** One device in the world: its name, its stable ID, whether it is on the tailnet, whose it is and its address. */
interface Device {
  readonly name: string
  readonly id: string
  readonly present: boolean
  readonly user: number
  readonly ip: string
}
/** dinghy (excluded), skiff (an agent host), his laptop and phone (members), a colleague's device. */
interface World {
  readonly dinghy: Device
  readonly skiff: Device
  readonly laptop: Device
  readonly phone: Device
  readonly colleague: Device
}
const START: World = {
  dinghy: { name: "dinghy", id: "nDinghy0", present: true, user: HIS, ip: "100.101.102.130" },
  skiff: { name: "skiff", id: "nSkiff0", present: true, user: HIS, ip: "100.101.102.104" },
  laptop: { name: "laptop", id: "nLaptop0", present: true, user: HIS, ip: "100.101.102.140" },
  phone: { name: "phone", id: "nPhone0", present: true, user: HIS, ip: "100.101.102.110" },
  colleague: { name: "theirs", id: "nTheirs0", present: true, user: 9, ip: "100.101.102.120" },
}

const statusOf = (world: World): TailscaleStatus => ({
  backendState: "Running",
  dnsName: Option.some("harbor.example-tailnet.ts.net"),
  ips: ["100.101.102.103"],
  userId: Option.some(HIS),
  tagged: false,
  peers: [world.dinghy, world.skiff, world.laptop, world.phone, world.colleague].flatMap((device): ReadonlyArray<PeerStatus> =>
    [{ dnsName: Option.some(`${device.name}.example-tailnet.ts.net`), stableId: Option.some(device.id), os: "linux", lastSeen: Option.none(), hostName: device.name, ips: [device.ip], userId: Option.some(device.user), tagged: false, shared: false }].filter(() => device.present),
  ),
})

// ── The steps ──

const DAMAGES = ["delete", "empty", "truncate", "garbage", "mode-000", "directory"] as const
type Damage = (typeof DAMAGES)[number]
/** Which copies a damage step hits. */
const TARGETS = { "1": [0], "2": [1], both: [0, 1] } as const

/** A step: a change of the world, the store damaged, the owner's command, or a configure or request (no change). */
type Step = { readonly kind: "world"; readonly name: string; readonly change: (world: World, n: number, pick: Pick) => World } | { readonly kind: "damage"; readonly name: string; readonly damage: Damage; readonly copies: ReadonlyArray<0 | 1> } | { readonly kind: "owner" | "configure" | "configure-unread" | "request"; readonly name: string }

const renamed = (device: Device, pick: Pick): Device => ({ ...device, name: pick(["lifeboat", "raft", `${device.name}-2`, "tender"]) })
const world = (name: string, change: (world: World, n: number, pick: Pick) => World): Step => ({ kind: "world", name, change })
const STEPS: ReadonlyArray<Step> = [
  world("rename-dinghy", (each, _, pick) => ({ ...each, dinghy: renamed(each.dinghy, pick) })),
  world("rename-skiff", (each, _, pick) => ({ ...each, skiff: renamed(each.skiff, pick) })),
  world("rekey-dinghy", (each, n) => ({ ...each, dinghy: { ...each.dinghy, id: `nDinghy${n}` } })),
  world("rekey-skiff", (each, n) => ({ ...each, skiff: { ...each.skiff, id: `nSkiff${n}` } })),
  world("remove-dinghy", (each) => ({ ...each, dinghy: { ...each.dinghy, present: false } })),
  world("readd-dinghy", (each) => ({ ...each, dinghy: { ...each.dinghy, present: true } })),
  world("laptop-takes-dinghy", (each) => ({ ...each, laptop: { ...each.laptop, name: "dinghy" } })),
  world("laptop-takes-skiff", (each) => ({ ...each, laptop: { ...each.laptop, name: "skiff" } })),
  world("laptop-back", (each) => ({ ...each, laptop: { ...each.laptop, name: "laptop" } })),
  world("colleague-takes-dinghy", (each) => ({ ...each, colleague: { ...each.colleague, name: "dinghy" } })),
  world("colleague-takes-skiff", (each) => ({ ...each, colleague: { ...each.colleague, name: "skiff" } })),
  { kind: "configure", name: "configure" },
  { kind: "configure-unread", name: "configure-unread" },
  { kind: "request", name: "request" },
  { kind: "owner", name: "owner-rekeys" },
  ...DAMAGES.flatMap((damage) => Object.entries(TARGETS).map(([which, copies]): Step => ({ kind: "damage", name: `${damage}:${which}`, damage, copies }))),
]
const MIN_EACH = 60

/** A path made writable again (a mode-000 file opened, a directory in its place removed) before the next damage. */
const reopened = (path: string) => {
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) return rmSync(path, { recursive: true, force: true })
  chmodSync(path, 0o600)
}
const textAt = (path: string) => Option.getOrElse(Option.map(Option.liftPredicate(path, existsSync), (each) => readFileSync(each, "utf8")), () => "")
const damaged = (path: string, damage: Damage) => {
  if (existsSync(path)) reopened(path)
  const text = textAt(path)
  const effects: Record<Damage, () => void> = {
    delete: () => rmSync(path, { force: true }),
    empty: () => writeFileSync(path, ""),
    truncate: () => writeFileSync(path, text.slice(0, Math.floor(text.length / 2))),
    garbage: () => writeFileSync(path, "\u0000\u00ff{garbage"),
    "mode-000": () => (writeFileSync(path, text), chmodSync(path, 0o000)),
    directory: () => (rmSync(path, { force: true }), mkdirSync(path)),
  }
  effects[damage]()
}

/** A path's bytes and kind as they are now, to tell that a step wrote nothing. */
const snapshot = (path: string): string =>
  Match.value(Option.map(Option.liftPredicate(path, existsSync), (each) => statSync(each))).pipe(
    Match.when(Option.isNone, () => "absent"),
    Match.orElse((info) =>
      Option.match(Option.filter(info, (each) => !each.isDirectory() && (each.mode & 0o400) !== 0), {
        onNone: () => `other:${Option.match(info, { onNone: () => 0, onSome: (each) => each.mode })}`,
        onSome: () => `file:${readFileSync(path, "utf8")}`,
      }),
    ),
  )

const served = (kind: RouteKind, members: Members, address: string) =>
  decide({ listener: "tailnet", kind, source: sourceOf(address, members), host: "harbor:8240", hosts: ["harbor:8240"], origin: "http://harbor:8240", pageHeader: true, json: true, paired: false }, { tailnetRead: "member", tailnetWrite: members.write })._tag === "Serve"
const admitted = (device: Device, kinds: ReadonlyArray<RouteKind>, members: Members) => device.present && ROUTE_KINDS.some((kind) => kinds.includes(kind) && served(kind, members, device.ip))

/** The owner's command: dinghy's and skiff's IDs now, keyed by hand (`--id`); refused when neither copy reads. */
const keyNow = (paths: readonly [string, string], now: World) => change(paths, (store) => withId(withId(store, "excluded", "dinghy", now.dinghy.id), "agents", "skiff", now.skiff.id))

/** The IDs the owner has ever keyed, by kind. */
interface Ever {
  readonly excluded: Set<string>
  readonly agents: Set<string>
}

/** `step` done: the world changed, the store damaged, or the owner's command run (its IDs then ever keyed). */
const stepped = async (step: Step, paths: readonly [string, string], now: World, ever: Ever, at: { readonly n: number; readonly pick: Pick }): Promise<World> => {
  if (step.kind === "world") return step.change(now, at.n, at.pick)
  if (step.kind === "damage") for (const each of step.copies) damaged(paths[each], step.damage)
  if (step.kind !== "owner") return now
  for (const path of paths) reopened(path)
  if (Exit.isSuccess(await Effect.runPromise(Effect.exit(keyNow(paths, now))))) {
    ever.excluded.add(now.dinghy.id)
    ever.agents.add(now.skiff.id)
  }
  return now
}

/** One generated run: its steps on a fresh store, each step's failures of the invariants. */
const runOnce = async (root: string, steps: ReadonlyArray<Step>, pick: Pick, run: number) => {
  const paths = [join(root, "state/opencode-digest/devices.json"), join(root, "config/opencode-digest/devices.json")] as const
  let now = START
  // The delivery step: the owner keys dinghy and skiff once, by the command.
  await Effect.runPromise(keyNow(paths, now))
  const ever: Ever = { excluded: new Set([now.dinghy.id]), agents: new Set([now.skiff.id]) }
  const wrong: Array<unknown> = []
  for (const [n, step] of steps.entries()) {
    now = await stepped(step, paths, now, ever, { n: run * 100 + n + 1, pick })
    // Then a request, as after every step: a configure ships names only and reads no store, a request reads both
    // copies, and neither writes a byte.
    const before = paths.map(snapshot)
    const read = Match.value(step.kind).pipe(
      Match.when("configure-unread", () => StatusRead.Unread({ why: "cli-failed" })),
      Match.orElse(() => StatusRead.Read({ status: statusOf(now) })),
    )
    const copies = await Effect.runPromise(readCopies(paths))
    const members = membersWith("member-except-hosts", keysOf(NAMED, copies[0], copies[1]), read, NOW)
    const seen = { run, n, step: step.name, now, members, copies: copies.map(copyWord) }
    if (!Bun.deepEquals(before, paths.map(snapshot))) wrong.push({ ...seen, wrote: before })
    if (ever.excluded.has(now.dinghy.id) && admitted(now.dinghy, ["read", "mark", "answer"], members)) wrong.push({ ...seen, let: "dinghy" })
    if (ever.agents.has(now.skiff.id) && admitted(now.skiff, ["mark", "answer"], members)) wrong.push({ ...seen, let: "skiff" })
    if (admitted(now.colleague, ["read", "mark", "answer"], members)) wrong.push({ ...seen, let: "colleague" })
  }
  for (const path of paths) reopened(path)
  return wrong
}

describe("the device store over time, on disk", () => {
  test("a device ever keyed is never let in unpaired, no automatic step touches an ID, whatever is lost; and every step kind is reached", async () => {
    const random = generator(20_261_124)
    using held = scratch("digest-devices-seq-")
    const runs = Array.from({ length: 360 }, (_, run) => ({ run, steps: Array.from({ length: 16 }, () => random.pick(STEPS)) }))
    const wrong: Array<unknown> = []
    for (const { run, steps } of runs) wrong.push(...(await runOnce(join(held.path, `run${run}`), steps, random.pick, run)))
    expect(wrong.slice(0, 2)).toEqual([])
    const counts = STEPS.map((step) => [step.name, runs.flatMap((each) => each.steps).filter((each) => each === step).length] as const)
    expect(counts.filter(([, count]) => count < MIN_EACH)).toEqual([])
  }, 60_000)
})

// ── The files themselves ──

const storeAt = (path: string): Option.Option<Store> => Match.valueTags(copyOfText(readFileSync(path, "utf8")), { Read: ({ store }) => Option.some(store), Absent: () => Option.none(), Unreadable: () => Option.none(), Invalid: () => Option.none() })
const said = (copy: Copy) => copyWord(copy)

describe("the store's files", () => {
  test("a write replaces both copies whole, 0600, and leaves no temporary file or lock behind", async () => {
    using held = scratch("digest-devices-write-")
    const paths = [join(held.path, "state/devices.json"), join(held.path, "config/opencode-digest/devices.json")] as const
    await Effect.runPromise(change(paths, (store) => withId(store, "excluded", "dinghy", "nDinghy1")))
    expect(paths.map(storeAt)).toEqual(paths.map(() => Option.some({ v: 1, agents: [], excluded: [{ name: "dinghy", ids: ["nDinghy1"] }] })))
    expect(paths.map((path) => statSync(path).mode & 0o777)).toEqual([0o600, 0o600])
    expect([readdirSync(join(held.path, "state")), readdirSync(join(held.path, "config/opencode-digest"))]).toEqual([["devices.json"], ["devices.json"]])
  })

  test("reading never fails: each damaged form is a condition", async () => {
    using held = scratch("digest-devices-read-")
    const path = join(held.path, "devices.json")
    const conditions = [said(await Effect.runPromise(readCopy(path)))]
    for (const damage of DAMAGES) {
      writeFileSync(path, '{"v":1,"agents":[],"excluded":[]}')
      damaged(path, damage)
      conditions.push(said(await Effect.runPromise(readCopy(path))))
      if (existsSync(path)) reopened(path)
    }
    expect(conditions).toEqual(["absent", "absent", "unparsable", "unparsable", "unparsable", "unreadable-EACCES", "unreadable-EISDIR"])
  })

  test("a store neither copy reads is refused and left as it is; one copy readable is the start of the next write", async () => {
    using held = scratch("digest-devices-refuse-")
    const paths = [join(held.path, "a/devices.json"), join(held.path, "b/devices.json")] as const
    await Effect.runPromise(change(paths, (store) => withId(store, "excluded", "dinghy", "nDinghy1")))
    damaged(paths[0], "garbage")
    damaged(paths[1], "truncate")
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(change(paths, (store) => withId(store, "excluded", "dinghy", "nDinghy2")))))).toBe(true)
    expect(readFileSync(paths[0], "utf8")).toBe("\u0000\u00ff{garbage")
    writeFileSync(paths[1], '{"v":1,"agents":[],"excluded":[{"name":"dinghy","ids":["nDinghy1"]}]}')
    await Effect.runPromise(change(paths, (store) => withId(store, "excluded", "dinghy", "nDinghy2")))
    expect(paths.map((path) => Option.map(storeAt(path), (store) => store.excluded))).toEqual(paths.map(() => Option.some([{ name: "dinghy", ids: ["nDinghy1", "nDinghy2"] }])))
  })
})

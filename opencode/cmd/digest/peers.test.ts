// @reads all
// @reads-reason computed read at mods/digest/filestore/devices.ts: Effect.tryPromise({ try: () => stat(path), catch: codeOf }).pipe(
// One page over every host (unit 5, the read half), against a model. Two and three digests run in-process, each with
// its own scratch log and marks and its own listener on a loopback scratch port, wired as each other's named peers
// through the real HTTP handlers (`/peer/view.json` on a listener that applies the tailnet's policy, read as a
// tailnet member). A seeded run draws steps:
// - a message in a project of one host (two hosts may each have a project of the same name),
// - a mark (read, unread, Later) or a rename made on the host that owns the item,
// - a host going down and coming back on its port, a host on another wire version and back,
// - a write sent to a host from another host's page origin, which must be refused and change nothing.
// After each step every host reads its peers once, and each page's merged view must equal the model's: its own
// projects, each up peer's (ids qualified by the peer, its renames applied), and each peer's state and last seen.
// Effect tests on Bun's platform services: the scratch folders through FileSystem and Path, the pages over HTTP
// through HttpClient.
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe } from "bun:test"
import { Array as Arr, Clock, Effect, Exit, FileSystem, Layer, Match, Option, Path, Ref, Schema, Scope } from "effect"
import { expect, it } from "effect-bun-test"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import * as Listener from "@dotfiles/opencode-digest/http/listener"
import { pull, unreadAll } from "@dotfiles/opencode-digest/http/peers"
import { markOf, nameOf } from "@dotfiles/opencode-digest/marks"
import { noTailnet, type PeerStatus, StatusRead } from "@dotfiles/opencode-digest/bind"
import * as FileDevices from "@dotfiles/opencode-digest/filestore/devices"
import { locateIn, type NamedPeer, NOT_ALLOWED, type Peer, peerId, peerOriginsOf, type Sighting, type Target, UNSEEN } from "@dotfiles/opencode-digest/peers"
import * as LivePeers from "@dotfiles/opencode-digest/process/peers"
import { handlersOf, probeKeeping, STARTING, writeConfigOf } from "./server.ts"
import { hangGuard } from "../../tests/hang-guard.ts"

/** The platform the cases run on: Bun's file system and path, and a fetch HTTP client. */
const Platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

/** A seeded generator of numbers in [0, 1) (mulberry32). */
const drawer = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ["macbook", "workbox", "spare"]
const PROJECTS = ["harbor", "ledger", "atlas"]
const T0 = Date.parse("2026-11-20T12:00:00Z")
const LATER_UNTIL = T0 + 30 * 86_400_000
const one = <A,>(found: A): NonNullable<A> => Option.getOrThrow(Option.fromNullishOr(found))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type MessageState = "unread" | "read" | "later"

/** The model of one host: its projects by default name (each with its messages' states and its rename), up, its wire. */
interface ModelHost {
  readonly projects: Map<string, { readonly root: string; rename: string; readonly messages: Map<string, MessageState> }>
  up: boolean
  old: boolean
  /** By viewer: the pull at which the viewer last read this host well. */
  readonly seenBy: Map<string, number>
}

/** One live digest: its handlers and log, its peers as read, its listener's scope and port, its wire switch. */
interface Live {
  readonly name: string
  readonly handlers: Listener.Handlers
  readonly log: ReturnType<typeof FileLog.make>
  readonly peers: Ref.Ref<ReadonlyArray<Peer>>
  readonly named: ReadonlyArray<NamedPeer>
  readonly old: Ref.Ref<boolean>
  readonly sighting: Ref.Ref<Sighting>
  /** Read Tailscale (the world's invented status) and the store again, as the plugin does at each recheck. */
  readonly probe: Effect.Effect<unknown>
  scope: Scope.Closeable
  port: number
}

/** Listen as a tailnet listener on loopback (the tailnet's policy, tailnetRead member), on `port` (0: any free one). */
const open = (handlers: Listener.Handlers, port: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const bound = yield* Scope.provide(scope)(Listener.listen({ address: Listener.HOSTNAME, port, listener: "tailnet", names: [] }, handlers, "/nonexistent/loop-probe-x/dist", () => caller.address))
    return { scope, port: bound.port }
  })

interface Shown {
  readonly host: string
  readonly defaultName: string
  readonly name: string
  readonly inbox: ReadonlyArray<string>
  readonly later: ReadonlyArray<string>
}

/** Projects in a fixed order: by host, then default name. */
const byPlace = (a: Shown, b: Shown) => Number(`${a.host}/${a.defaultName}` > `${b.host}/${b.defaultName}`) - Number(`${a.host}/${a.defaultName}` < `${b.host}/${b.defaultName}`)

/** A page's view as the cases read it: each project's host, names and messages; each peer's state and last seen. */
const ViewJson = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      host: Schema.String,
      name: Schema.String,
      defaultName: Schema.String,
      id: Schema.String,
      inbox: Schema.Array(Schema.Struct({ id: Schema.String, unread: Schema.Boolean })),
      later: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
  peers: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String, lastSeen: Schema.optionalKey(Schema.Number), reason: Schema.String })),
})
type ViewJson = typeof ViewJson.Type
const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(ViewJson))

/** A merged view as compared: each project's host, names and messages; each peer's state and last seen. */
const normal = (view: ViewJson) => ({
  projects: view.projects
    .map((project): Shown => ({
      host: project.host,
      defaultName: project.defaultName,
      name: project.name,
      inbox: project.inbox.map((message) => `${message.id}=${message.unread}`).toSorted(),
      later: project.later.map((message) => message.id).toSorted(),
    }))
    .toSorted(byPlace),
  peers: view.peers.map((peer) => ({ name: peer.name, state: peer.state, lastSeen: Option.fromUndefinedOr(peer.lastSeen) })),
})

/** What host `viewer`'s page should show, from the model. */
const expected = (model: Map<string, ModelHost>, viewer: string) => {
  const projectsOf = (host: string, qualify: (id: string) => string) =>
    [...one(model.get(host)).projects.entries()].map(([name, project]): Shown => ({
      host,
      defaultName: name,
      name: Option.getOrElse(Option.liftPredicate(project.rename, (given) => given !== ""), () => name),
      inbox: [...project.messages.entries()].flatMap(([id, state]) => Option.toArray(Option.liftPredicate(`${qualify(id)}=${state === "unread"}`, () => state !== "later"))).toSorted(),
      later: [...project.messages.entries()].flatMap(([id, state]) => Option.toArray(Option.liftPredicate(qualify(id), () => state === "later"))).toSorted(),
    }))
  const others = [...model.keys()].filter((name) => name !== viewer)
  const readable = others.filter((name) => one(model.get(name)).up && !one(model.get(name)).old)
  return {
    projects: [...projectsOf(viewer, (id) => id), ...readable.flatMap((name) => projectsOf(name, (id) => peerId(name, id)))].toSorted(byPlace),
    peers: others.map((name) => {
      const host = one(model.get(name))
      const state = Match.value(host).pipe(
        Match.when({ up: false }, () => "down"),
        Match.when({ old: true }, () => "update"),
        Match.orElse(() => "up"),
      )
      return { name, state, lastSeen: Option.fromUndefinedOr(host.seenBy.get(viewer)) }
    }),
  }
}

/** His user, the hosts' invented tailnet addresses and stable IDs, his phone's, and the device he excluded. */
const HIS = 7
const ADDRESS: ReadonlyMap<string, string> = new Map([
  ["macbook", "100.101.102.11"],
  ["workbox", "100.101.102.12"],
  ["spare", "100.101.102.13"],
])
const PHONE = "100.101.102.110"
const EXCLUDED = "lenovo-rescue"
const deviceOf = (name: string, address: string): PeerStatus => ({
  dnsName: Option.some(`${name}.example-tailnet.ts.net`),
  stableId: Option.some(`n-${name}`),
  hostName: name,
  os: "linux",
  lastSeen: Option.none(),
  ips: [address],
  userId: Option.some(HIS),
  tagged: false,
  shared: false,
})

/** Tailscale's status as host `name` reads it: itself, the other hosts of the world, his phone and the excluded device. */
const statusOf = (name: string, hosts: ReadonlyArray<string>): StatusRead =>
  StatusRead.Read({
    status: {
      backendState: "Running",
      dnsName: Option.some(`${name}.example-tailnet.ts.net`),
      ips: [one(ADDRESS.get(name))],
      userId: Option.some(HIS),
      tagged: false,
      peers: [...hosts.flatMap((other) => Option.toArray(Option.liftPredicate(other, (each) => each !== name)).map((each) => deviceOf(each, one(ADDRESS.get(each))))), deviceOf("phone", PHONE), deviceOf(EXCLUDED, "100.101.102.120")],
    },
  })

/**
 * How a host's device store stands: `keyed`, its agent hosts (the other hosts) and its exclusion keyed by stable ID,
 * in both copies, as `bun cmd/digest/devices.ts` writes them; `unkeyed`, no store yet (the exclusion unkeyed closes
 * the whole tailnet to pairing).
 */
type StoreState = "keyed" | "unkeyed"

/** Write host `name`'s store copies under `dir` (scratch only, never the real store). */
const keep = (paths: readonly [string, string], state: StoreState, others: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (state === "unkeyed") return
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = { v: 1, agents: others.map((other) => ({ name: other, ids: [`n-${other}`] })), excluded: [{ name: EXCLUDED, ids: [`n-${EXCLUDED}`] }] }
    for (const copy of paths) {
      yield* fs.makeDirectory(path.dirname(copy), { recursive: true })
      yield* fs.writeFileString(copy, encodeJson(store))
    }
  })

/** Who calls the listeners now: every listener of the world takes it as the socket's peer address (a tailnet one). */
const caller = { address: PHONE }

/** Close every host's listener: the world's end, whatever the case came to. */
const closeAll = (lives: ReadonlyArray<Live>) => Effect.forEach(lives, (live) => Scope.close(live.scope, Exit.void), { discard: true })

/**
 * A world of `count` hosts in a scratch folder, each naming the others as peers and as agent hosts, as
 * scripts/daily.ts ships them: his own devices read unpaired (`reads`, default "member") and write unless they are
 * agent machines. Each host's device store stands as `stores` says, and its members and peers come from it through
 * the plugin's own probeKeeping. Its listeners close, and its folder goes, with the case's scope.
 */
const world = (count: number, reads: (name: string) => "paired" | "member" = () => "member", stores: (name: string) => StoreState = () => "keyed") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "digest-peers-" })
    const lives: Array<Live> = []
    yield* Effect.addFinalizer(() => closeAll(lives))
    const hosts = NAMES.slice(0, count)
    for (const name of hosts) {
      const others = hosts.filter((other) => other !== name)
      const named = others.map((other) => ({ name: other, host: other }))
      const options = { dir: path.join(dir, name), timezone: "UTC", tailnetRead: reads(name), tailnetWrite: "member-except-hosts" as const, agentHosts: others, excludedDevices: [EXCLUDED], name, peers: named }
      const paths = FileDevices.pathsOf(options.dir, path.join(dir, `${name}-config`))
      yield* keep(paths, stores(name), others)
      const log = FileLog.make(options.dir)
      const peers = Ref.makeUnsafe(unreadAll(named))
      const members = Ref.makeUnsafe(STARTING)
      const sighting = Ref.makeUnsafe(UNSEEN)
      const probe = probeKeeping(writeConfigOf(options), Effect.succeed({ tailnet: noTailnet("test"), status: statusOf(name, hosts) }), members, FileDevices.readCopies(paths), (seen) => Ref.set(sighting, seen))
      const old = Ref.makeUnsafe(false)
      const base = handlersOf(options, log, { question: () => Effect.die("no answer here"), item: () => Effect.die("no answer here") }, Effect.succeed("yes"), Ref.get(members), {
        known: Ref.get(peers),
        pull: Effect.void,
        origins: Effect.flatMap(Ref.get(sighting), (seen) => Effect.map(Clock.currentTimeMillis, (now) => peerOriginsOf(named, seen, now, 8240))),
        pages: Effect.succeed([]),
      })
      // A host on another wire: its peer view says wire 2, with a view this build must not parse loosely.
      const newer = Effect.succeed(`{"wire":2,"host":"${name}","view":{"projects":"elsewhere"}}`)
      const handlers: Listener.Handlers = { ...base, peerView: Effect.flatMap(Ref.get(old), (isOld) => Option.match(Option.liftPredicate(isOld, Boolean), { onSome: () => newer, onNone: () => base.peerView })) }
      yield* probe
      const bound = yield* open(handlers, 0)
      lives.push({ name, handlers, log, peers, named, old, sighting, probe, scope: bound.scope, port: bound.port })
    }
    return lives
  })

/**
 * Every host reads its peers once, at time `at`, each at its loopback port, as from its own tailnet address (the
 * listeners' peer-address seam): first each host reads Tailscale and its store again, as the plugin does.
 */
const pullAll = (lives: ReadonlyArray<Live>, at: number) =>
  Effect.forEach(
    lives,
    (live) => {
      const located = new Map(live.named.map((peer): readonly [string, Target] => [peer.name, { name: peer.name, base: `http://${Listener.HOSTNAME}:${one(lives.find((each) => each.name === peer.name)).port}` }]))
      return Effect.andThen(
        Effect.andThen(
          live.probe,
          Effect.sync(() => {
            caller.address = one(ADDRESS.get(live.name))
          }),
        ),
        Effect.ensuring(
          pull(live.named, Effect.succeed(located), LivePeers.get, live.peers, Effect.succeed(at)),
          Effect.sync(() => {
            caller.address = PHONE
          }),
        ),
      )
    },
    { discard: true },
  )

/** A page's view, as his phone reads it: over its listener when it is up, from its handlers when it is down. */
const pageView = (live: Live, up: boolean) =>
  Effect.gen(function* () {
    if (!up) return yield* decodeView(yield* live.handlers.view)
    const client = yield* HttpClient.HttpClient
    const answer = yield* client.get(`http://${Listener.HOSTNAME}:${live.port}/view.json`)
    return yield* decodeView(yield* answer.text)
  }).pipe(Effect.orDie)

/** What one step does: to a host (`live`, modelled as `host`) at time `t`, drawing with `pick`; its line in the trace. */
interface Step {
  readonly live: Live
  readonly host: ModelHost
  readonly lives: ReadonlyArray<Live>
  readonly t: number
  readonly n: number
  readonly pick: <A>(all: ReadonlyArray<A>) => A
}

const message = ({ live, host, t, n, pick }: Step) =>
  Effect.gen(function* () {
    const project = pick(PROJECTS)
    const known = Option.fromUndefinedOr(host.projects.get(project))
    const root = Option.getOrElse(Option.map(known, (each) => each.root), () => `r-${live.name}-${project}`)
    if (Option.isNone(known)) {
      yield* live.log.append(encodeLine(DigestEvent.cases.Run.make({ v: VERSION, t, root, host: live.name, repo: project, dir: Option.none(), name: Option.some(project) })), t)
      host.projects.set(project, { root, rename: "", messages: new Map() })
    }
    const id = `m${n}`
    yield* live.log.append(encodeLine(DigestEvent.cases.Item.make({ answer: Option.none(), choices: Option.none(), v: VERSION, t, root, id, text: `Step ${n} ships.`, state: "done", owner: "mine", who: Option.none(), level: Option.none(), unit: Option.none() })), t)
    one(host.projects.get(project)).messages.set(`item:${root}:${id}`, "unread")
    return `${live.name} message in ${project}`
  })

const mark = ({ live, host, t, pick }: Step) =>
  Effect.gen(function* () {
    const project = pick([...host.projects.values()])
    const id = pick([...project.messages.keys()])
    const kind = pick(["read", "unread", "later"] as const)
    yield* live.handlers.write(markOf(id, t, kind, Option.liftPredicate(LATER_UNTIL, () => kind === "later")))
    project.messages.set(id, kind)
    return `${live.name} ${kind} ${id}`
  })

const rename = ({ live, host, t, pick }: Step) =>
  Effect.gen(function* () {
    const [name, project] = pick([...host.projects.entries()])
    const view = yield* pageView(live, false)
    const id = one(view.projects.find((each) => each.host === live.name && each.defaultName === name)).id
    const to = pick(["", `${name} renamed`, "Billing"])
    yield* live.handlers.write(nameOf(id, to, t))
    project.rename = to
    return `${live.name} rename ${name} "${to}"`
  })

const downOrUp = ({ live, host }: Step) =>
  Effect.gen(function* () {
    if (host.up) yield* Scope.close(live.scope, Exit.void)
    else live.scope = (yield* open(live.handlers, live.port)).scope
    host.up = !host.up
    return `${live.name} ${["down", "up"][Number(host.up)]}`
  })

const wire = ({ live, host }: Step) =>
  Effect.gen(function* () {
    host.old = !host.old
    yield* Ref.set(live.old, host.old)
    return `${live.name} wire ${2 - Number(!host.old)}`
  })

const foreignWrite = ({ live, host, lives, pick }: Step) =>
  Effect.gen(function* () {
    const from = pick(lives.filter((each) => each.name !== live.name))
    if (host.up) {
      const client = yield* HttpClient.HttpClient
      const request = HttpClientRequest.post(`http://${Listener.HOSTNAME}:${live.port}/api/name`, { headers: { origin: `http://${Listener.HOSTNAME}:${from.port}`, [Listener.PAGE_HEADER]: "1" } })
      const sent = yield* client.execute(HttpClientRequest.bodyText(request, encodeJson({ project: "harbor", name: "taken over" }), "application/json"))
      expect(sent.status).toBe(403)
    }
    return `${from.name}'s page writes to ${live.name}: refused`
  })

/** The steps by the share of draws below which each is taken; a host with no project yet always gets a message. */
const STEPS: ReadonlyArray<readonly [number, (step: Step) => Effect.Effect<string, unknown, HttpClient.HttpClient>]> = [
  [0.35, message],
  [0.6, mark],
  [0.7, rename],
  [0.82, downOrUp],
  [0.9, wire],
  [1, foreignWrite],
]

const simulate = (seed: number, count: number, steps: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lives = yield* world(count)
      const draw = drawer(seed)
      const pick = <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(all, Math.floor(draw() * all.length)))
      const model = new Map(lives.map((live): readonly [string, ModelHost] => [live.name, { projects: new Map(), up: true, old: false, seenBy: new Map() }]))
      const trace: Array<string> = []
      for (let n = 1; n <= steps; n++) {
        const live = pick(lives)
        const host = one(model.get(live.name))
        const roll = Option.getOrElse(Option.liftPredicate(draw(), () => host.projects.size > 0), () => 0)
        const [, act] = one(STEPS.find(([below]) => roll < below))
        trace.push(`${n} ${yield* act({ live, host, lives, t: T0 + n * 1000, n, pick })}`)
        yield* pullAll(lives, n)
        for (const [name, each] of model) for (const viewer of model.keys()) if (viewer !== name && each.up && !each.old) each.seenBy.set(viewer, n)
        for (const viewer of lives) {
          const actual = normal(yield* pageView(viewer, one(model.get(viewer.name)).up))
          expect(actual, `seed ${seed}, ${viewer.name}'s page after:\n${trace.join("\n")}`).toEqual(expected(model, viewer.name))
        }
      }
    }),
  )

/** Each peer of `live` as its page shows it: name, state and why. */
const peersOf = (live: Live) => Effect.map(pageView(live, false), (view) => view.peers.map((peer) => ({ name: peer.name, state: peer.state, reason: peer.reason })))

describe("one page over every host", () => {
  it.scopedLive.layer(Platform)("a host whose policy lets this one read it is read; one that needs pairing is unavailable, and the page says why", () =>
    Effect.gen(function* () {
      const lives = yield* world(2, (name) => Option.getOrElse(Option.as(Option.liftPredicate(name, (each) => each === "workbox"), "paired" as const), () => "member" as const))
      yield* pullAll(lives, 1)
      // macbook reads the tailnet as a member may: workbox (paired) refuses it; workbox reads macbook (member). Each
      // page is read from its handlers: workbox's own page needs pairing on its listener.
      expect(yield* peersOf(one(lives[0]))).toEqual([{ name: "workbox", state: "down", reason: NOT_ALLOWED }])
      expect(yield* peersOf(one(lives[1]))).toEqual([{ name: "macbook", state: "up", reason: "" }])
    }),
  )

  it.scopedLive.layer(Platform)("a peer host reads as an agent machine: allowed once its store keys the hosts, refused while it is unkeyed, and the page says why", () =>
    Effect.gen(function* () {
      // workbox has no device store yet: its exclusion is unkeyed, so its tailnet is pairing-only for every source.
      const lives = yield* world(3, () => "member", (name) => Option.getOrElse(Option.as(Option.liftPredicate(name, (each) => each === "workbox"), "unkeyed" as const), () => "keyed" as const))
      yield* pullAll(lives, 1)
      expect(yield* peersOf(one(lives[0]))).toEqual([
        { name: "workbox", state: "down", reason: NOT_ALLOWED },
        { name: "spare", state: "up", reason: "" },
      ])
      expect(yield* peersOf(one(lives[2]))).toEqual([
        { name: "macbook", state: "up", reason: "" },
        { name: "workbox", state: "down", reason: NOT_ALLOWED },
      ])
      // workbox itself reads the others: their stores key it as an agent machine, which may read.
      expect(yield* peersOf(one(lives[1]))).toEqual([
        { name: "macbook", state: "up", reason: "" },
        { name: "spare", state: "up", reason: "" },
      ])
      // Each host finds its peers by the stable IDs its own store keys, never by name: workbox, keying none, finds none.
      const now = yield* Clock.currentTimeMillis
      expect([...locateIn(one(lives[0]).named, yield* Ref.get(one(lives[0]).sighting), now, 8240).keys()]).toEqual(["workbox", "spare"])
      expect([...locateIn(one(lives[1]).named, yield* Ref.get(one(lives[1]).sighting), now, 8240).keys()]).toEqual([])
    }),
  )

  it.scopedLive.layer(Platform)(
    "two hosts: each page shows its own projects and the other's, as the model says, through every step",
    () => Effect.forEach([1, 2, 3, 4, 5, 6], (seed) => simulate(seed, 2, 30), { discard: true }),
    hangGuard("process-fixture"),
  )

  it.scopedLive.layer(Platform)(
    "three hosts: each reads the other two directly, none relays, and one down or on another wire leaves the rest whole",
    () => Effect.forEach([11, 12, 13, 14], (seed) => simulate(seed, 3, 30), { discard: true }),
    hangGuard("process-fixture"),
  )
})

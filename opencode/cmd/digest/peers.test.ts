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
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Array as Arr, Effect, Exit, Match, Option, Ref, Scope } from "effect"
import { DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import * as Listener from "@dotfiles/opencode-digest/http/listener"
import { pull, unreadAll } from "@dotfiles/opencode-digest/http/peers"
import { markOf, nameOf } from "@dotfiles/opencode-digest/marks"
import { type NamedPeer, NOT_ALLOWED, type Peer, peerId, type Target } from "@dotfiles/opencode-digest/peers"
import * as LivePeers from "@dotfiles/opencode-digest/process/peers"
import { scratch } from "../../tests/scratch.ts"
import { handlersOf } from "./server.ts"

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
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const one = <A,>(found: A): NonNullable<A> => Option.getOrThrow(Option.fromNullishOr(found))

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
  scope: Scope.Closeable
  port: number
}

/** Listen as a tailnet listener on loopback (the tailnet's policy, tailnetRead member), on `port` (0: any free one). */
const open = (handlers: Listener.Handlers, port: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const bound = yield* Scope.provide(scope)(Listener.listen({ address: Listener.HOSTNAME, port, listener: "tailnet", names: [] }, handlers, "/nonexistent/loop-probe-x/dist"))
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

interface ViewJson {
  readonly projects: ReadonlyArray<{ host: string; name: string; defaultName: string; id: string; inbox: ReadonlyArray<{ id: string; unread: boolean }>; later: ReadonlyArray<{ id: string }> }>
  readonly peers: ReadonlyArray<{ name: string; state: string; lastSeen?: number; reason: string }>
}

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

/** A world of `count` hosts, each naming the others as peers. */
const world = async (dir: string, count: number, reads: (name: string) => "paired" | "member" = () => "member"): Promise<ReadonlyArray<Live>> => {
  const lives: Array<Live> = []
  for (const name of NAMES.slice(0, count)) {
    const named = NAMES.slice(0, count).flatMap((other) => Option.toArray(Option.liftPredicate({ name: other, host: other }, () => other !== name)))
    const options = { dir: join(dir, name), timezone: "UTC", tailnetRead: reads(name), name, peers: named }
    const log = FileLog.make(options.dir)
    const peers = Ref.makeUnsafe(unreadAll(named))
    const old = Ref.makeUnsafe(false)
    const base = handlersOf(options, log, { question: () => Effect.die("no answer here"), item: () => Effect.die("no answer here") }, Effect.succeed("yes"), Ref.get(peers))
    // A host on another wire: its peer view says wire 2, with a view this build must not parse loosely.
    const newer = Effect.succeed(`{"wire":2,"host":"${name}","view":{"projects":"elsewhere"}}`)
    const handlers: Listener.Handlers = { ...base, peerView: Effect.flatMap(Ref.get(old), (isOld) => Option.match(Option.liftPredicate(isOld, Boolean), { onSome: () => newer, onNone: () => base.peerView })) }
    const bound = await run(open(handlers, 0))
    lives.push({ name, handlers, log, peers, named, old, scope: bound.scope, port: bound.port })
  }
  return lives
}

/** Every host reads its peers once, at time `at`, each at its loopback port. */
const pullAll = (lives: ReadonlyArray<Live>, at: number) =>
  Effect.forEach(
    lives,
    (live) => {
      const located = new Map(live.named.map((peer): readonly [string, Target] => [peer.name, { name: peer.name, base: `http://${Listener.HOSTNAME}:${one(lives.find((each) => each.name === peer.name)).port}` }]))
      return pull(live.named, Effect.succeed(located), LivePeers.get, live.peers, Effect.succeed(at))
    },
    { discard: true },
  )

/** A page's view: over its listener when it is up, from its handlers when it is down. */
const pageView = async (live: Live, up: boolean): Promise<ViewJson> => {
  if (up) return (await fetch(`http://${Listener.HOSTNAME}:${live.port}/view.json`)).json()
  return JSON.parse(await run(live.handlers.view))
}

/** What one step does: to a host (`live`, modelled as `host`) at time `t`, drawing with `pick`; its line in the trace. */
interface Step {
  readonly live: Live
  readonly host: ModelHost
  readonly lives: ReadonlyArray<Live>
  readonly t: number
  readonly n: number
  readonly pick: <A>(all: ReadonlyArray<A>) => A
}

const message = async ({ live, host, t, n, pick }: Step) => {
  const project = pick(PROJECTS)
  const known = Option.fromUndefinedOr(host.projects.get(project))
  const root = Option.getOrElse(Option.map(known, (each) => each.root), () => `r-${live.name}-${project}`)
  if (Option.isNone(known)) {
    await run(live.log.append(encodeLine(DigestEvent.cases.Run.make({ v: VERSION, t, root, host: live.name, repo: project, dir: Option.none(), name: Option.some(project) })), t))
    host.projects.set(project, { root, rename: "", messages: new Map() })
  }
  const id = `m${n}`
  await run(live.log.append(encodeLine(DigestEvent.cases.Item.make({ answer: Option.none(), choices: Option.none(), v: VERSION, t, root, id, text: `Step ${n} ships.`, state: "done", owner: "mine", who: Option.none(), level: Option.none(), unit: Option.none() })), t))
  one(host.projects.get(project)).messages.set(`item:${root}:${id}`, "unread")
  return `${live.name} message in ${project}`
}

const mark = async ({ live, host, t, pick }: Step) => {
  const project = pick([...host.projects.values()])
  const id = pick([...project.messages.keys()])
  const kind = pick(["read", "unread", "later"] as const)
  await run(live.handlers.write(markOf(id, t, kind, Option.liftPredicate(LATER_UNTIL, () => kind === "later"))))
  project.messages.set(id, kind)
  return `${live.name} ${kind} ${id}`
}

const rename = async ({ live, host, t, pick }: Step) => {
  const [name, project] = pick([...host.projects.entries()])
  const view: ViewJson = JSON.parse(await run(live.handlers.view))
  const id = one(view.projects.find((each) => each.host === live.name && each.defaultName === name)).id
  const to = pick(["", `${name} renamed`, "Billing"])
  await run(live.handlers.write(nameOf(id, to, t)))
  project.rename = to
  return `${live.name} rename ${name} "${to}"`
}

const downOrUp = async ({ live, host }: Step) => {
  if (host.up) await run(Scope.close(live.scope, Exit.void))
  else live.scope = (await run(open(live.handlers, live.port))).scope
  host.up = !host.up
  return `${live.name} ${["down", "up"][Number(host.up)]}`
}

const wire = async ({ live, host }: Step) => {
  host.old = !host.old
  await run(Ref.set(live.old, host.old))
  return `${live.name} wire ${2 - Number(!host.old)}`
}

const foreignWrite = async ({ live, host, lives, pick }: Step) => {
  const from = pick(lives.filter((each) => each.name !== live.name))
  if (host.up) {
    const sent = await fetch(`http://${Listener.HOSTNAME}:${live.port}/api/name`, {
      method: "POST",
      headers: { origin: `http://${Listener.HOSTNAME}:${from.port}`, "content-type": "application/json", [Listener.PAGE_HEADER]: "1" },
      body: JSON.stringify({ project: "harbor", name: "taken over" }),
    })
    expect(sent.status).toBe(403)
  }
  return `${from.name}'s page writes to ${live.name}: refused`
}

/** The steps by the share of draws below which each is taken; a host with no project yet always gets a message. */
const STEPS: ReadonlyArray<readonly [number, (step: Step) => Promise<string>]> = [
  [0.35, message],
  [0.6, mark],
  [0.7, rename],
  [0.82, downOrUp],
  [0.9, wire],
  [1, foreignWrite],
]

const simulate = async (seed: number, count: number, steps: number) => {
  using held = scratch("digest-peers-")
  const lives = await world(held.path, count)
  await using _closed = { [Symbol.asyncDispose]: () => run(Effect.forEach(lives, (live) => Scope.close(live.scope, Exit.void), { discard: true })) }
  const draw = drawer(seed)
  const pick = <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(all, Math.floor(draw() * all.length)))
  const model = new Map(lives.map((live): readonly [string, ModelHost] => [live.name, { projects: new Map(), up: true, old: false, seenBy: new Map() }]))
  const trace: Array<string> = []
  for (let n = 1; n <= steps; n++) {
    const live = pick(lives)
    const host = one(model.get(live.name))
    const roll = Option.getOrElse(Option.liftPredicate(draw(), () => host.projects.size > 0), () => 0)
    const [, act] = one(STEPS.find(([below]) => roll < below))
    trace.push(`${n} ${await act({ live, host, lives, t: T0 + n * 1000, n, pick })}`)
    await run(pullAll(lives, n))
    for (const [name, each] of model) for (const viewer of model.keys()) if (viewer !== name && each.up && !each.old) each.seenBy.set(viewer, n)
    for (const viewer of lives) {
      const actual = normal(await pageView(viewer, one(model.get(viewer.name)).up))
      expect(actual, `seed ${seed}, ${viewer.name}'s page after:\n${trace.join("\n")}`).toEqual(expected(model, viewer.name))
    }
  }
}

describe("one page over every host", () => {
  test("a host whose policy lets this one read it is read; one that needs pairing is unavailable, and the page says why", async () => {
    using held = scratch("digest-peers-")
    const lives = await world(held.path, 2, (name) => Option.getOrElse(Option.as(Option.liftPredicate(name, (each) => each === "workbox"), "paired" as const), () => "member" as const))
    await using _closed = { [Symbol.asyncDispose]: () => run(Effect.forEach(lives, (live) => Scope.close(live.scope, Exit.void), { discard: true })) }
    await run(pullAll(lives, 1))
    const peersOf = async (live: Live) => (await pageView(live, false)).peers.map((peer) => ({ name: peer.name, state: peer.state, reason: peer.reason }))
    // macbook reads the tailnet as a member may: workbox (paired) refuses it; workbox reads macbook (member). Each
    // page is read from its handlers: workbox's own page needs pairing on its listener.
    expect(await peersOf(one(lives[0]))).toEqual([{ name: "workbox", state: "down", reason: NOT_ALLOWED }])
    expect(await peersOf(one(lives[1]))).toEqual([{ name: "macbook", state: "up", reason: "" }])
  })

  test("two hosts: each page shows its own projects and the other's, as the model says, through every step", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) await simulate(seed, 2, 30)
  }, 60_000)

  test("three hosts: each reads the other two directly, none relays, and one down or on another wire leaves the rest whole", async () => {
    for (const seed of [11, 12, 13, 14]) await simulate(seed, 3, 30)
  }, 60_000)
})

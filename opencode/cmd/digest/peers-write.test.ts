// One page over every host, the write half (unit 5, round 2): the page a host serves writes to the host that owns
// an item directly, and that host decides it by its own policy. Through real listeners on loopback ports (the
// tailnet's source injected at the listener's peer-address seam), with two and three hosts, sending Origin headers
// and preflights directly as a browser would, and as a client no browser binds would.
//
// THE PROPERTY, for every origin O and request R to host B: a cross-origin write succeeds (and its answer is readable
// by the page, Access-Control-Allow-Origin: O) only if O is exactly a page origin of a peer B names, as B's own status
// and device store key that peer now (each of its addresses, its MagicDNS name, that name's first label, on the
// page's port), AND B's own policy accepts the same request from B's own page, tokenless, from that source. A token
// that arrives cross-origin is never read. No read is ever readable cross-origin. On B's loopback listener a peer's
// origin gains nothing. CORS is the browser's guard; the source rule, by the socket's address, is the network's: a
// client no browser binds may send any Origin, and is still judged by where it is.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Array as Arr, Effect, Exit, Option, Ref, Scope } from "effect"
import { AnswerOutcome } from "@dotfiles/opencode-digest/answers"
import { noTailnet, type PeerStatus, StatusRead } from "@dotfiles/opencode-digest/bind"
import * as FileDevices from "@dotfiles/opencode-digest/filestore/devices"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import * as Listener from "@dotfiles/opencode-digest/http/listener"
import type { Listener as ListenerKind } from "@dotfiles/opencode-digest/policy"
import { type Sighting, UNSEEN } from "@dotfiles/opencode-digest/peers"
import { scratch } from "../../tests/scratch.ts"
import { handlersOf, livePeers, probeKeeping, STARTING, writeConfigOf } from "./server.ts"

const PORT = 8240
const HIS = 7
const COLLEAGUE_USER = 9
const NAMES = ["macbook", "workbox", "spare"]
const V4: ReadonlyMap<string, string> = new Map([
  ["macbook", "100.101.102.11"],
  ["workbox", "100.101.102.12"],
  ["spare", "100.101.102.13"],
])
const V6: ReadonlyMap<string, string> = new Map([
  ["macbook", "fd7a:115c:a1e0::11"],
  ["workbox", "fd7a:115c:a1e0::12"],
  ["spare", "fd7a:115c:a1e0::13"],
])
const PHONE = "100.101.102.110"
const COLLEAGUE = "100.101.102.120"
const LENOVO = "100.101.102.121"
const SUFFIX = "example-tailnet.ts.net"
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const one = <A,>(found: A): NonNullable<A> => Option.getOrThrow(Option.fromNullishOr(found))

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

const device = (name: string, id: string, ips: ReadonlyArray<string>, user = HIS): PeerStatus => ({
  dnsName: Option.some(`${name}.${SUFFIX}`),
  stableId: Option.some(id),
  hostName: name,
  os: "linux",
  lastSeen: Option.none(),
  ips,
  userId: Option.some(user),
  tagged: false,
  shared: false,
})

/**
 * What B's Tailscale says about the world, beyond the plain truth:
 * - `plain`: every host under its own name;
 * - `renamed`: macbook's device is now called `macbook-old` (its stable ID unchanged);
 * - `taken-colleague` / `taken-phone`: renamed, and a colleague's device, or his own phone, now carries `macbook`;
 * - `gone`: macbook's device is not on the tailnet.
 */
type Scene = "plain" | "renamed" | "taken-colleague" | "taken-phone" | "gone"
const SCENES: ReadonlyArray<Scene> = ["plain", "renamed", "taken-colleague", "taken-phone", "gone"]

const macbookName = (scene: Scene) => Option.getOrElse(Option.liftPredicate("macbook", () => scene === "plain"), () => "macbook-old")

/** Tailscale's status as host `self` reads it in `scene`. */
const statusOf = (self: string, hosts: ReadonlyArray<string>, scene: Scene): StatusRead => {
  const nameOf = (host: string) => Option.getOrElse(Option.liftPredicate(host, (each) => each !== "macbook"), () => macbookName(scene))
  const others = hosts.flatMap((each) => Option.toArray(Option.liftPredicate(each, (host) => host !== self && !(host === "macbook" && scene === "gone")))).map((host) => device(nameOf(host), `n-${host}`, [one(V4.get(host)), one(V6.get(host))]))
  const phoneName = Option.getOrElse(Option.liftPredicate("macbook", () => scene === "taken-phone"), () => "phone")
  const colleagueName = Option.getOrElse(Option.liftPredicate("macbook", () => scene === "taken-colleague"), () => "laptop")
  return StatusRead.Read({
    status: {
      backendState: "Running",
      dnsName: Option.some(`${self}.${SUFFIX}`),
      ips: [one(V4.get(self)), one(V6.get(self))],
      userId: Option.some(HIS),
      tagged: false,
      peers: [...others, device(phoneName, "n-phone", [PHONE]), device(colleagueName, "n-laptop", [COLLEAGUE], COLLEAGUE_USER), device("lenovo-rescue", "n-lenovo", [LENOVO])],
    },
  })
}

/** How a host's device store stands: its agent hosts and exclusion keyed by stable ID, or no store yet. */
type StoreState = "keyed" | "unkeyed"

/** One live host: its listeners (tailnet and loopback, both on loopback ports), what it wrote and answered. */
interface Host {
  readonly name: string
  readonly tailnet: number
  readonly loopback: number
  readonly scope: Scope.Closeable
  readonly writes: () => Promise<number>
  readonly token: string
  /** Read Tailscale (the scene) and the store again, as the plugin does at each recheck. */
  readonly see: (scene: Scene) => Promise<void>
}

/** Who calls the tailnet listeners now (the socket's peer address they see). */
const caller = { address: PHONE }

/** Host `name` of `hosts`, its store as `store`, its peers the other hosts; tailnetRead member, member-except-hosts. */
const host = async (dir: string, name: string, hosts: ReadonlyArray<string>, store: StoreState): Promise<Host> => {
  const others = hosts.filter((other) => other !== name)
  const options = {
    dir: join(dir, name),
    timezone: "UTC",
    port: PORT,
    tailnetRead: "member" as const,
    tailnetWrite: "member-except-hosts" as const,
    agentHosts: others,
    excludedDevices: ["lenovo-rescue"],
    name,
    peers: others.map((other) => ({ name: other, host: other })),
  }
  const paths = FileDevices.pathsOf(options.dir, join(dir, `${name}-config`))
  if (store === "keyed") {
    const keyed = { v: 1, agents: others.map((other) => ({ name: other, ids: [`n-${other}`] })), excluded: [{ name: "lenovo-rescue", ids: ["n-lenovo"] }] }
    for (const path of paths) await Bun.write(path, JSON.stringify(keyed))
  }
  const members = Ref.makeUnsafe(STARTING)
  const sighting = Ref.makeUnsafe<Sighting>(UNSEEN)
  const scene = Ref.makeUnsafe<Scene>("plain")
  const probe = probeKeeping(
    writeConfigOf(options),
    Effect.map(Ref.get(scene), (now) => ({ tailnet: noTailnet("test"), status: statusOf(name, hosts, now) })),
    members,
    FileDevices.readCopies(paths),
    (seen) => Ref.set(sighting, seen),
  )
  const written = Ref.makeUnsafe(0)
  const peers = await run(livePeers(options, sighting))
  const base = handlersOf(options, FileLog.make(options.dir), { question: () => Effect.die("unused"), item: () => Effect.die("unused") }, Effect.succeed("yes"), Ref.get(members), peers)
  const handlers: Listener.Handlers = {
    ...base,
    write: (line) => Effect.andThen(base.write(line), Ref.update(written, (n) => n + 1)),
    answer: () => Effect.as(Ref.update(written, (n) => n + 1), AnswerOutcome.Answered({ replaced: Option.none() })),
  }
  await run(probe)
  const scope = await run(Scope.make())
  const listenAs = (listener: ListenerKind) =>
    run(Scope.provide(scope)(Listener.listen({ address: Listener.HOSTNAME, port: 0, listener, names: [] }, handlers, "/nonexistent/loop-probe-x/dist", () => caller.address)))
  const tailnet = await listenAs("tailnet")
  const loopback = await listenAs("loopback")
  // B's own token, paired on its own page (its own origin) from his phone: the token an agent machine's browser would hold there.
  const code = await run(base.pairing.issue(Date.now()))
  const own = `http://${Listener.HOSTNAME}:${tailnet.port}`
  const paired = await fetch(`${own}/api/pair`, { method: "POST", body: JSON.stringify({ code }), headers: { origin: own, [Listener.PAGE_HEADER]: "1", "content-type": "application/json" } })
  const { token }: { readonly token: string } = await paired.json()
  return {
    name,
    tailnet: tailnet.port,
    loopback: loopback.port,
    scope,
    token,
    writes: () => run(Ref.get(written)),
    see: (now) => run(Effect.asVoid(Effect.andThen(Ref.set(scene, now), probe))),
  }
}

/** The hosts of `names`, one after another, each with its store as `storeOf` says. */
const hostsOf = async (dir: string, names: ReadonlyArray<string>, storeOf: (name: string) => StoreState): Promise<ReadonlyArray<Host>> => {
  const made: Array<Host> = []
  for (const name of names) made.push(await host(dir, name, names, storeOf(name)))
  return made
}

/** The origins B should allow in `scene`: each peer's page as B keys it, every spelling a browser would send. */
const expectedOrigins = (b: string, hosts: ReadonlyArray<string>, scene: Scene, store: StoreState): ReadonlyArray<string> =>
  hosts
    .filter((other) => other !== b && store === "keyed" && !(other === "macbook" && scene === "gone"))
    .flatMap((other) => {
      const name = Option.getOrElse(Option.liftPredicate(other, (each) => each !== "macbook"), () => macbookName(scene))
      return [`http://${one(V4.get(other))}:${PORT}`, `http://[${one(V6.get(other))}]:${PORT}`, `http://${name}.${SUFFIX}:${PORT}`, `http://${name}:${PORT}`]
    })

/** Every origin worth sending: each host's forms, under the names any scene gives, and near misses of each. */
const CANDIDATES: ReadonlyArray<string> = [
  ...NAMES.flatMap((name) => [one(V4.get(name)), `[${one(V6.get(name))}]`, `${name}.${SUFFIX}`, name, `${name}-old.${SUFFIX}`, `${name}-old`]).flatMap((place) => [
    `http://${place}:${PORT}`,
    `http://${place}:${PORT + 1}`,
    `https://${place}:${PORT}`,
    `http://${place}:${PORT}/`,
    `http://${place.toUpperCase()}:${PORT}`,
    `http://${place}`,
  ]),
  `http://phone:${PORT}`,
  `http://phone.${SUFFIX}:${PORT}`,
  `http://${PHONE}:${PORT}`,
  `http://${COLLEAGUE}:${PORT}`,
  `http://laptop.${SUFFIX}:${PORT}`,
  `http://${LENOVO}:${PORT}`,
  `http://evil.example:${PORT}`,
  `http://macbook.${SUFFIX}.evil.example:${PORT}`,
  `http://${Listener.HOSTNAME}:${PORT}`,
  "null",
  "*",
]

type Route = "mark" | "later" | "name" | "answer" | "pair" | "view"
const ROUTES: ReadonlyArray<Route> = ["mark", "later", "name", "answer", "pair", "view"]
const WRITE_ROUTES: ReadonlyArray<Route> = ["mark", "later", "name", "answer"]
const PATHS: Readonly<Record<Route, string>> = { mark: "/api/mark", later: "/api/later", name: "/api/name", answer: "/api/answer", pair: "/api/pair", view: "/view.json" }
const BODIES: Readonly<Record<Route, string>> = {
  mark: JSON.stringify({ id: "m1", mark: "read" }),
  later: JSON.stringify({ id: "m1" }),
  name: JSON.stringify({ project: "p1", name: "Billing" }),
  answer: JSON.stringify({ id: "m1", option: "yes" }),
  pair: JSON.stringify({ code: "000000" }),
  view: "",
}

/** One request as a browser's fetch (or a client no browser binds) would send it to `base`. */
const send = (base: string, route: Route, origin: Option.Option<string>, token: Option.Option<string>) =>
  fetch(`${base}${PATHS[route]}`, {
    method: Option.getOrElse(Option.liftPredicate("GET", () => route === "view"), () => "POST"),
    body: Option.getOrUndefined(Option.liftPredicate(BODIES[route], () => route !== "view")),
    headers: {
      "content-type": "application/json",
      [Listener.PAGE_HEADER]: "1",
      ...Option.match(origin, { onNone: () => ({}), onSome: (each) => ({ origin: each }) }),
      ...Option.match(token, { onNone: () => ({}), onSome: (each) => ({ "x-digest-token": each }) }),
    },
  })

const preflight = (base: string, route: Route, origin: string, headers: string) =>
  fetch(`${base}${PATHS[route]}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": Option.getOrElse(Option.liftPredicate("GET", () => route === "view"), () => "POST"), "access-control-request-headers": headers } })

const header = (answer: Response, name: string): string => Option.getOrElse(Option.fromNullishOr(answer.headers.get(name)), () => "")
const varies = (answer: Response) => header(answer, "vary").toLowerCase().split(",").map((each) => each.trim()).includes("origin")

/** The sources a request to B may come from: his phone, an agent machine (another host, or B itself), a colleague, his excluded device. */
const sourcesOf = (hosts: ReadonlyArray<string>): ReadonlyArray<string> => [PHONE, ...hosts.map((each) => one(V4.get(each))), COLLEAGUE, LENOVO]

const closeAll = (hosts: ReadonlyArray<Host>) => run(Effect.forEach(hosts, (each) => Scope.close(each.scope, Exit.void), { discard: true }))

/** Check the property on `count` hosts, B's store as `store`, for `draws` drawn (scene, origin, source, route, token). */
const property = async (seed: number, count: number, store: StoreState, draws: number) => {
  using held = scratch("digest-peers-write-")
  const names = NAMES.slice(0, count)
  const live = await hostsOf(held.path, names, (name) => Option.getOrElse(Option.liftPredicate(store, () => name === "workbox"), () => "keyed" as const))
  await using _closed = { [Symbol.asyncDispose]: () => closeAll(live) }
  const b = one(live.find((each) => each.name === "workbox"))
  const draw = drawer(seed)
  const pick = <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(all, Math.floor(draw() * all.length)))
  const own = `http://${Listener.HOSTNAME}:${b.tailnet}`
  for (let n = 0; n < draws; n++) {
    const scene = pick(SCENES)
    await b.see(scene)
    const allowed = expectedOrigins("workbox", names, scene, store)
    // Half the draws send an origin B allows now, so the accepting side is reached as often as the refusing one.
    const origin = Option.getOrElse(Option.liftPredicate(pick(Option.getOrElse(Option.liftPredicate(allowed, (each) => each.length > 0), () => CANDIDATES)), () => draw() < 0.5), () => pick(CANDIDATES))
    const source = pick(sourcesOf(names))
    const route = pick(ROUTES)
    const token = pick([Option.none(), Option.some(b.token), Option.some("not-a-token")])
    const trace = `seed ${seed}, ${count} hosts, store ${store}, scene ${scene}: ${route} from ${source} with Origin ${origin}, token ${Option.getOrElse(Option.map(token, (each) => Option.getOrElse(Option.as(Option.liftPredicate(each, (given) => given === b.token), "B's"), () => "junk")), () => "none")}`
    caller.address = source
    // B's own page, tokenless, from that source: what B's policy accepts.
    const before = await b.writes()
    const ownAnswer = await send(own, route, Option.some(own), Option.none())
    const ownWrote = (await b.writes()) - before
    const isAllowed = allowed.includes(origin)
    const isWrite = WRITE_ROUTES.includes(route)
    const at = await b.writes()
    const cross = await send(own, route, Option.some(origin), token)
    const crossWrote = (await b.writes()) - at
    // A read is served by source as ever (a browser cannot read it cross-origin: no Allow-Origin); a write only as above.
    const expectServed = Option.getOrElse(Option.liftPredicate(isAllowed && ownAnswer.ok, () => isWrite), () => route === "view" && ownAnswer.ok)
    expect({ ok: cross.ok, wrote: crossWrote > 0, allowOrigin: cross.headers.get("access-control-allow-origin"), varies: varies(cross) }, trace).toEqual({
      ok: expectServed,
      wrote: isWrite && expectServed && ownWrote > 0,
      // Readable by the page only where B lets that origin write: refusals too, so the page can say why.
      allowOrigin: Option.getOrNull(Option.liftPredicate(origin, () => isAllowed && isWrite)),
      varies: true,
    })
    expect(cross.headers.get("access-control-allow-credentials"), trace).toBeNull()
    // The preflight: answered for an allowed origin, a write route, POST and the page's headers alone; never the token header.
    const asked = pick(["content-type,x-digest-page", "content-type, x-digest-page", "x-digest-page,content-type,x-digest-token", "content-type,x-digest-page,authorization"])
    const pre = await preflight(own, route, origin, asked)
    const preOk = isAllowed && isWrite && !asked.includes("token") && !asked.includes("authorization")
    expect({ allowOrigin: pre.headers.get("access-control-allow-origin"), ok: pre.ok, varies: varies(pre) }, `${trace}, preflight asking ${asked}`).toEqual({
      allowOrigin: Option.getOrNull(Option.liftPredicate(origin, () => preOk)),
      ok: preOk,
      varies: true,
    })
    if (preOk) {
      expect(header(pre, "access-control-allow-methods").split(",").map((each) => each.trim()), trace).toEqual(["POST"])
      expect(header(pre, "access-control-allow-headers").toLowerCase(), trace).not.toContain("token")
    }
    // B's loopback listener: a peer's origin gains nothing there, preflight or request.
    const loop = `http://${Listener.HOSTNAME}:${b.loopback}`
    const viaLoop = await send(loop, route, Option.some(origin), Option.none())
    expect({ allowOrigin: viaLoop.headers.has("access-control-allow-origin"), refusedWrite: route === "view" || viaLoop.status === 403 }, `${trace}, on loopback`).toEqual({ allowOrigin: false, refusedWrite: true })
    expect((await preflight(loop, route, origin, "content-type,x-digest-page")).headers.get("access-control-allow-origin"), `${trace}, loopback preflight`).toBeNull()
  }
  caller.address = PHONE
}

describe("the page writes to the host that owns an item, under that host's own policy", () => {
  test("two hosts: a cross-origin write succeeds only from the peer's page origin and only where the owner's policy would serve its own page", async () => {
    for (const seed of [1, 2, 3]) await property(seed, 2, "keyed", 150)
  }, 120_000)

  test("three hosts: each peer's every origin, under renames and a name taken by another device, and nothing else", async () => {
    for (const seed of [11, 12]) await property(seed, 3, "keyed", 200)
  }, 120_000)

  test("a host whose device store keys nothing allows no peer origin at all", async () => {
    await property(21, 3, "unkeyed", 120)
  }, 120_000)

  test("the cases by hand: the phone writes from the peer's page; an agent machine's browser is refused there, its token ignored, and told to pair on B", async () => {
    using held = scratch("digest-peers-write-")
    const names = NAMES.slice(0, 2)
    const [a, b] = await hostsOf(held.path, names, () => "keyed")
    await using _closed = { [Symbol.asyncDispose]: () => closeAll([one(a), one(b)]) }
    const workbox = `http://${Listener.HOSTNAME}:${one(b).tailnet}`
    const fromMacbook = Option.some(`http://${one(V4.get("macbook"))}:${PORT}`)
    caller.address = PHONE
    const phone = await send(workbox, "mark", fromMacbook, Option.none())
    expect([phone.status, phone.headers.get("access-control-allow-origin")]).toEqual([204, `http://${one(V4.get("macbook"))}:${PORT}`])
    caller.address = one(V4.get("macbook"))
    const agent = await send(workbox, "mark", fromMacbook, Option.some(one(b).token))
    const said: { readonly reason?: string } = await agent.json()
    expect([agent.status, agent.headers.get("access-control-allow-origin"), said.reason]).toEqual([401, `http://${one(V4.get("macbook"))}:${PORT}`, expect.stringContaining("pair")])
    // The same token on B's own page is B's to read: the agent machine writes there once paired.
    expect((await send(workbox, "mark", Option.some(workbox), Option.some(one(b).token))).status).toBe(204)
    // A client no browser binds may claim the peer's origin: it is still judged by its address (a colleague's: refused).
    caller.address = COLLEAGUE
    expect((await send(workbox, "mark", fromMacbook, Option.none())).status).toBe(401)
    caller.address = PHONE
    expect(await one(b).writes()).toBe(2)
  }, 60_000)
})

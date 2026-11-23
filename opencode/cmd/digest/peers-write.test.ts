// One page over every host, the write half (unit 5, round 2): the page a host serves writes to the host that owns
// an item directly, and that host decides it by its own policy. Through real listeners on loopback ports (the
// tailnet's source injected at the listener's peer-address seam), with two and three hosts, sending Origin headers
// and preflights directly as a browser would, and as a client no browser binds would.
//
// THE PROPERTY, for every origin O and request R to host B: a cross-origin write succeeds (and its answer is readable
// by the page, Access-Control-Allow-Origin: O) only if O is exactly a page origin of a peer B names, as B's own status
// and device store key that peer now (each of its Tailscale addresses, never a name, on the page's port), AND B's
// own policy accepts the same request from B's own page, tokenless, from that source. A token that arrives
// cross-origin is never read. A read with any Origin but the page's own is refused. On B's loopback listener a peer's
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
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { closed } from "@dotfiles/opencode-digest/members"
import { isPeerWrite, type Listener as ListenerKind, type Preflight, preflightOf, ROUTE_KINDS, type RouteKind, SOURCES } from "@dotfiles/opencode-digest/policy"
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
/** An address outside Tailscale's ranges: what a source the tailnet listener should never see is spelled as. */
const OUTSIDE = "203.0.113.9"
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
    // The tailnet listener's names, as bind.ts gives them: they only send `GET /` on to the address (digest-address-only).
    run(Scope.provide(scope)(Listener.listen({ address: Listener.HOSTNAME, port: 0, listener, names: Option.getOrElse(Option.liftPredicate([`${name}.${SUFFIX}`, name], () => listener === "tailnet"), () => []) }, handlers, "/nonexistent/loop-probe-x/dist", () => caller.address)))
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

/**
 * The origins B should allow in `scene`: each peer's page by its keyed device's Tailscale addresses alone, as a browser
 * spells them. Never a name: which server answers a name is the resolver's choice, an address is Tailscale's routing.
 */
const expectedOrigins = (b: string, hosts: ReadonlyArray<string>, scene: Scene, store: StoreState): ReadonlyArray<string> =>
  hosts
    .filter((other) => other !== b && store === "keyed" && !(other === "macbook" && scene === "gone"))
    .flatMap((other) => [`http://${one(V4.get(other))}:${PORT}`, `http://[${one(V6.get(other))}]:${PORT}`])

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

/**
 * The routes a request may take: the four writes, the pairing, the view, and a POST to a path no write takes (the
 * page, the peers' view, a path under /api/ no route has), which the listener's kindOf calls a mark all the same.
 */
type Route = "mark" | "later" | "name" | "since" | "answer" | "pair" | "view" | "postPage" | "postPeerView" | "postNowhere"
const ROUTES: ReadonlyArray<Route> = ["mark", "later", "name", "since", "answer", "pair", "view", "postPage", "postPeerView", "postNowhere"]
const WRITE_ROUTES: ReadonlyArray<Route> = ["mark", "later", "name", "since", "answer"]
const PATHS: Readonly<Record<Route, string>> = {
  mark: "/api/mark",
  later: "/api/later",
  name: "/api/name",
  since: "/api/since",
  answer: "/api/answer",
  pair: "/api/pair",
  view: "/view.json",
  postPage: "/",
  postPeerView: "/peer/view.json",
  postNowhere: "/api/nowhere",
}
const BODIES: Readonly<Record<Route, string>> = {
  mark: JSON.stringify({ id: "m1", mark: "read" }),
  later: JSON.stringify({ id: "m1" }),
  name: JSON.stringify({ project: "p1", name: "Billing" }),
  since: "{}",
  answer: JSON.stringify({ id: "m1", option: "yes" }),
  pair: JSON.stringify({ code: "000000" }),
  view: "",
  postPage: JSON.stringify({ id: "m1", mark: "read" }),
  postPeerView: JSON.stringify({ id: "m1", mark: "read" }),
  postNowhere: JSON.stringify({ id: "m1", mark: "read" }),
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

/**
 * The sources a request to B may come from: his phone, an agent machine (another host, or B itself), a colleague, his
 * excluded device, and an address outside the tailnet (a client no browser binds, or a forwarded port).
 */
const sourcesOf = (hosts: ReadonlyArray<string>): ReadonlyArray<string> => [PHONE, ...hosts.map((each) => one(V4.get(each))), COLLEAGUE, LENOVO, OUTSIDE]

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
  // How often each side of the property was reached: a draw set that never accepts, or never refuses an allowed origin, proves little.
  const reached = { accepted: 0, refusedByPolicy: 0 }
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
    // A read that sends any Origin but the page's own is refused on the tailnet, token or not (digest-address-only,
    // policy.ts decide): no read is served cross-origin. A write only as the property says.
    const expectServed = isWrite && isAllowed && ownAnswer.ok
    expect({ ok: cross.ok, wrote: crossWrote > 0, allowOrigin: cross.headers.get("access-control-allow-origin"), varies: varies(cross) }, trace).toEqual({
      ok: expectServed,
      wrote: isWrite && expectServed && ownWrote > 0,
      // Readable by the page only where B lets that origin write: refusals too, so the page can say why.
      allowOrigin: Option.getOrNull(Option.liftPredicate(origin, () => isAllowed && isWrite)),
      varies: true,
    })
    expect(cross.headers.get("access-control-allow-credentials"), trace).toBeNull()
    // The preflight: answered for an allowed origin, a write route, a source on the tailnet, POST and the page's
    // headers alone; never the token header, never a path no write takes, never from outside the tailnet.
    const asked = pick(["content-type,x-digest-page", "content-type, x-digest-page", "x-digest-page,content-type,x-digest-token", "content-type,x-digest-page,authorization"])
    const pre = await preflight(own, route, origin, asked)
    const preOk = isAllowed && isWrite && source !== OUTSIDE && !asked.includes("token") && !asked.includes("authorization")
    expect({ allowOrigin: pre.headers.get("access-control-allow-origin"), ok: pre.ok, varies: varies(pre) }, `${trace}, preflight asking ${asked}`).toEqual({
      allowOrigin: Option.getOrNull(Option.liftPredicate(origin, () => preOk)),
      ok: preOk,
      varies: true,
    })
    reached.accepted += Number(isWrite && cross.ok)
    reached.refusedByPolicy += Number(isWrite && isAllowed && !cross.ok)
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
  return reached
}

describe("the page writes to the host that owns an item, under that host's own policy", () => {
  test("two hosts: a cross-origin write succeeds only from the peer's page origin and only where the owner's policy would serve its own page", async () => {
    for (const seed of [1, 2, 3]) {
      const reached = await property(seed, 2, "keyed", 150)
      expect(Math.min(reached.accepted, reached.refusedByPolicy), `seed ${seed}`).toBeGreaterThan(3)
    }
  }, 120_000)

  test("three hosts: each peer's every origin, under renames and a name taken by another device, and nothing else", async () => {
    for (const seed of [11, 12]) {
      const reached = await property(seed, 3, "keyed", 200)
      expect(Math.min(reached.accepted, reached.refusedByPolicy), `seed ${seed}`).toBeGreaterThan(3)
    }
  }, 120_000)

  test("a host whose device store keys nothing allows no peer origin at all", async () => {
    expect((await property(21, 3, "unkeyed", 120)).accepted).toBe(0)
  }, 120_000)

  test("where digest-address-only's rules and the peers' meet: each case served or refused as both together say", async () => {
    using held = scratch("digest-peers-write-")
    const [a, b] = await hostsOf(held.path, NAMES.slice(0, 2), () => "keyed")
    await using _closed = { [Symbol.asyncDispose]: () => closeAll([one(a), one(b)]) }
    const port = one(b).tailnet
    const workbox = `http://${Listener.HOSTNAME}:${port}`
    const loop = `http://${Listener.HOSTNAME}:${one(b).loopback}`
    const v4 = `http://${one(V4.get("macbook"))}:${PORT}`
    const v6 = `http://[${one(V6.get("macbook"))}]:${PORT}`
    caller.address = PHONE
    /** One case: where it goes (B's tailnet listener unless `base`), the route, its Origin and Host, and what both rule sets say. */
    interface Case {
      readonly what: string
      readonly route: Route
      readonly origin: string
      readonly host?: string
      readonly base?: string
      /** The request's status, and whether its answer carries Allow-Origin. */
      readonly expect: readonly [number, boolean]
      /** The preflight's status (204 granted), and whether it carries Allow-Origin. */
      readonly pre: readonly [number, boolean]
    }
    const CASES: ReadonlyArray<Case> = [
      { what: "the keyed peer's IPv4 address origin", route: "mark", origin: v4, expect: [204, true], pre: [204, true] },
      { what: "the keyed peer's IPv6 address origin", route: "answer", origin: v6, expect: [200, true], pre: [204, true] },
      { what: "the peer's short name as origin", route: "mark", origin: `http://macbook:${PORT}`, expect: [403, false], pre: [405, false] },
      { what: "the peer's MagicDNS name as origin", route: "mark", origin: `http://macbook.${SUFFIX}:${PORT}`, expect: [403, false], pre: [405, false] },
      { what: "the peer's address origin with a path /", route: "mark", origin: `${v4}/`, expect: [403, false], pre: [405, false] },
      { what: "the peer's address origin with a path /x", route: "mark", origin: `${v4}/x`, expect: [403, false], pre: [405, false] },
      { what: "the peer's address origin doubled", route: "mark", origin: `${v4}, ${v4}`, expect: [403, false], pre: [405, false] },
      { what: "null", route: "mark", origin: "null", expect: [403, false], pre: [405, false] },
      { what: "a blank Origin", route: "mark", origin: " ", expect: [403, false], pre: [405, false] },
      { what: "an empty Origin", route: "mark", origin: "", expect: [403, false], pre: [405, false] },
      { what: "the peer's address origin in upper-case scheme", route: "mark", origin: v4.replace("http", "HTTP"), expect: [403, false], pre: [405, false] },
      { what: "a non-peer address: his phone's", route: "mark", origin: `http://${PHONE}:${PORT}`, expect: [403, false], pre: [405, false] },
      { what: "a non-peer address: a colleague's", route: "mark", origin: `http://${COLLEAGUE}:${PORT}`, expect: [403, false], pre: [405, false] },
      { what: "a peer write to B's short name as Host", route: "mark", origin: v4, host: `workbox:${port}`, expect: [421, false], pre: [421, false] },
      { what: "a peer write to B's MagicDNS name as Host", route: "answer", origin: v4, host: `workbox.${SUFFIX}:${port}`, expect: [421, false], pre: [421, false] },
      { what: "a peer write to a foreign Host", route: "mark", origin: v4, host: `evil.example:${port}`, expect: [421, false], pre: [421, false] },
      { what: "a read of the view from the peer's origin", route: "view", origin: v4, expect: [403, false], pre: [405, false] },
      { what: "a pairing from the peer's origin", route: "pair", origin: v4, expect: [403, false], pre: [405, false] },
      // A POST to a path no write takes is judged as with no peer named: the address-only rules' 403 for a foreign Origin.
      { what: "a POST to the page from the peer's origin", route: "postPage", origin: v4, expect: [403, false], pre: [405, false] },
      { what: "a POST to the peers' view from the peer's origin", route: "postPeerView", origin: v6, expect: [403, false], pre: [405, false] },
      { what: "a POST to a path under /api/ no route has, from the peer's origin", route: "postNowhere", origin: v4, expect: [403, false], pre: [405, false] },
      { what: "the peer's origin on B's loopback listener", route: "mark", origin: v4, base: loop, expect: [403, false], pre: [405, false] },
    ]
    const before = await one(b).writes()
    const rows = []
    for (const each of CASES) {
      const base = each.base ?? workbox
      const host = Option.getOrElse(Option.fromNullishOr(each.host), () => new URL(base).host)
      const method = Option.getOrElse(Option.liftPredicate("GET", () => each.route === "view"), () => "POST")
      const sent = await fetch(`${base}${PATHS[each.route]}`, {
        method,
        body: Option.getOrUndefined(Option.liftPredicate(BODIES[each.route], () => each.route !== "view")),
        headers: { host, origin: each.origin, "content-type": "application/json", [Listener.PAGE_HEADER]: "1" },
      })
      const pre = await fetch(`${base}${PATHS[each.route]}`, { method: "OPTIONS", headers: { host, origin: each.origin, "access-control-request-method": method, "access-control-request-headers": "content-type,x-digest-page" } })
      rows.push({ what: each.what, request: [sent.status, sent.headers.has("access-control-allow-origin")], preflight: [pre.status, pre.headers.has("access-control-allow-origin")], varies: varies(sent) })
    }
    expect(rows).toEqual(CASES.map((each) => ({ what: each.what, request: [...each.expect], preflight: [...each.pre], varies: true })))
    // The two address-origin writes alone were stored.
    expect((await one(b).writes()) - before).toBe(2)
  }, 60_000)

  test("the round 2 verifier's probes: a page at the keyed peer's bare name or full MagicDNS name writes nothing on B, from the phone", async () => {
    // In headless Chrome a resolver mapped `macbook` (and its full name) to a server that is not the keyed device; its
    // page marked, set aside, renamed and answered on B (round-2-receipts/chrome-short-label.txt, chrome-full-name.txt).
    using held = scratch("digest-peers-write-")
    const names = NAMES.slice(0, 2)
    const [a, b] = await hostsOf(held.path, names, () => "keyed")
    await using _closed = { [Symbol.asyncDispose]: () => closeAll([one(a), one(b)]) }
    const workbox = `http://${Listener.HOSTNAME}:${one(b).tailnet}`
    caller.address = PHONE
    for (const origin of [`http://macbook:${PORT}`, `http://macbook.${SUFFIX}:${PORT}`]) {
      for (const route of WRITE_ROUTES) {
        const sent = await send(workbox, route, Option.some(origin), Option.none())
        expect([origin, route, sent.status, sent.headers.has("access-control-allow-origin")]).toEqual([origin, route, 403, false])
        const pre = await preflight(workbox, route, origin, "content-type,x-digest-page")
        expect([origin, route, pre.ok, pre.headers.has("access-control-allow-origin")]).toEqual([origin, route, false, false])
      }
    }
    expect(await one(b).writes()).toBe(0)
    // The same writes from the keyed device's address origin are his phone's, and land.
    expect((await send(workbox, "mark", Option.some(`http://${one(V4.get("macbook"))}:${PORT}`), Option.none())).status).toBe(204)
    expect((await send(workbox, "mark", Option.some(`http://[${one(V6.get("macbook"))}]:${PORT}`), Option.none())).status).toBe(204)
    expect(await one(b).writes()).toBe(2)
    // B's view gives its own page by address, where a page opened under a name sends him to act on other hosts' items.
    const view: { readonly pages?: ReadonlyArray<string> } = await (await fetch(`${workbox}/view.json`)).json()
    expect(view.pages).toEqual([`http://${one(V4.get("workbox"))}:${PORT}`, `http://[${one(V6.get("workbox"))}]:${PORT}`])
  }, 60_000)

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

describe("a peer's write and its preflight, as the policy decides them, at every combination", () => {
  // The listener asks isPeerWrite and preflightOf only once its order let a request through: on the tailnet its Host
  // is then the address, and its source is never "local". Each function still keeps its whole condition on its own,
  // so a caller that asks earlier gets no peer write: checked here over every combination, against a reference
  // written apart from policy.ts.
  const ABSENT = "<absent>"
  const ADDRESS = "100.101.102.12:8240"
  const PEER4 = `http://${one(V4.get("macbook"))}:${PORT}`
  const PEER6 = `http://[${one(V6.get("macbook"))}]:${PORT}`
  const OWN = `http://${ADDRESS}`
  const HOSTS_SENT = [ADDRESS, "100.101.102.12:9999", `workbox.${SUFFIX}:8240`, "workbox:8240", "evil.example:8240", "", ABSENT]
  const ORIGINS_SENT = [PEER4, PEER6, `${PEER4}/`, `http://macbook:${PORT}`, OWN, `http://${PHONE}:${PORT}`, "null", "", ABSENT]
  const METHODS = ["POST", "post", "GET", "PUT"]
  const HEADER_SETS: ReadonlyArray<ReadonlyArray<string>> = [[], ["content-type"], ["content-type", "x-digest-page"], ["x-digest-page", "x-digest-token"], ["authorization"]]
  /** No peer, the keyed peer's two address origins, and those with this page's own origin among them by mistake. */
  const PEER_LISTS: ReadonlyArray<ReadonlyArray<string>> = [[], [PEER4, PEER6], [PEER4, PEER6, OWN]]
  const sentOf = (value: string) => Option.liftPredicate(value, (each) => each !== ABSENT)

  /** The reference: a write a peer's page may send, and the preflight that announces it. */
  const reference = (asked: Preflight, peers: ReadonlyArray<string>) => {
    const host = Option.getOrElse(asked.host, () => ABSENT)
    const origin = Option.getOrElse(asked.origin, () => ABSENT)
    const write = asked.listener === "tailnet" && (asked.kind === "mark" || asked.kind === "answer") && asked.hosts.includes(host) && origin !== `http://${host}` && peers.includes(origin)
    const preflight = write && asked.method === "POST" && ["own", "agent", "other"].includes(asked.source) && asked.headers.every((each) => each === "content-type" || each === "x-digest-page")
    return { write, preflight }
  }

  test("isPeerWrite and preflightOf decide as the reference does", () => {
    const kinds: ReadonlyArray<RouteKind | "none"> = [...ROUTE_KINDS, "none"]
    const listeners: ReadonlyArray<ListenerKind> = ["tailnet", "loopback"]
    const all = listeners.flatMap((listener) =>
      kinds.flatMap((kind) =>
        SOURCES.flatMap((source) =>
          HOSTS_SENT.flatMap((host) =>
            ORIGINS_SENT.flatMap((origin) =>
              METHODS.flatMap((method) =>
                HEADER_SETS.flatMap((headers) => PEER_LISTS.map((peers) => ({ asked: { listener, kind, source, host: sentOf(host), hosts: [ADDRESS], origin: sentOf(origin), method, headers }, peers }))),
              ),
            ),
          ),
        ),
      ),
    )
    const wrong = all.flatMap(({ asked, peers }) => {
      const want = reference(asked, peers)
      const write = asked.kind !== "none" && isPeerWrite({ listener: asked.listener, kind: asked.kind, host: asked.host, hosts: asked.hosts, origin: asked.origin }, peers)
      const got = { write, preflight: preflightOf(asked, peers) }
      const shown = { asked: { ...asked, host: Option.getOrNull(asked.host), origin: Option.getOrNull(asked.origin) }, peers, want, got }
      return Option.toArray(Option.liftPredicate(shown, () => got.write !== want.write || got.preflight !== want.preflight))
    })
    expect(wrong.slice(0, 3)).toEqual([])
    // Both sides reached: a property no case satisfies, or every case does, proves little.
    const granted = all.filter(({ asked, peers }) => reference(asked, peers).preflight).length
    expect([granted > 0, granted < all.length]).toEqual([true, true])
  })
})

describe("the page's CSP names its peers' pages exactly, and nothing else", () => {
  // Through the real listener: whatever `peerPages` holds (peers.ts gives exact origins; a config, a bug or a hostile
  // status could give anything), the page's connect-src is 'self' and the plain origins among them, in order, and
  // no other directive changes. Each entry drawn knows whether it was built plain: the reference is the drawing.
  const DIRECTIVES = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]

  test("from drawn lists of peer pages, plain and not", async () => {
    using held = scratch("digest-peers-csp-")
    const dist = join(held.path, "dist")
    await Bun.write(join(dist, "index.html"), "<!doctype html><title>Digest</title>")
    const pages = { now: Arr.empty<string>() }
    const handlers: Listener.Handlers = {
      view: Effect.succeed("{}"),
      peerView: Effect.succeed("{}"),
      write: () => Effect.void,
      now: Effect.sync(() => Date.now()),
      zone: "UTC",
      answer: () => Effect.succeed(AnswerOutcome.Answered({ replaced: Option.none() })),
      pairing: FilePairing.make(join(held.path, "pairing")),
      health: Effect.succeed("digest ok"),
      tailnetRead: "member",
      members: Effect.succeed(closed("none", Date.now())),
      peerOrigins: Effect.succeed([]),
      peerPages: Effect.sync(() => pages.now),
    }
    const scope = await run(Scope.make())
    await using _closed = { [Symbol.asyncDispose]: () => run(Scope.close(scope, Exit.void)) }
    const served = await run(Scope.provide(scope)(Listener.listen({ address: Listener.HOSTNAME, port: 0, listener: "loopback", names: [] }, handlers, dist, () => Listener.HOSTNAME)))
    const draw = drawer(31)
    const pick = <A,>(all: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(all, Math.floor(draw() * all.length)))
    const label = () => Array.from({ length: 1 + Math.floor(draw() * 8) }, () => pick([..."abcdefghijklmnopqrstuvwxyz0123456789"])).join("")
    const port = () => String(1 + Math.floor(draw() * 65_535))
    /** A host as a plain origin spells it: a lower case name of labels, an IPv4 address, a bracketed IPv6 one. */
    const place = () => pick([() => label(), () => `${label()}.${SUFFIX}`, () => one(V4.get(pick(NAMES))), () => `[${one(V6.get(pick(NAMES)))}]`])()
    /** One entry and whether it is plain: a plain origin, or one of the ways a value is not one. */
    const entry = (): readonly [string, boolean] => {
      const plain = `http://${place()}:${port()}`
      return pick<readonly [string, boolean]>([
        [plain, true],
        [plain, true],
        [`${plain} 'unsafe-inline'`, false],
        [`${plain}; script-src *`, false],
        [`${plain}/`, false],
        [`${plain}/x`, false],
        [plain.replace("http://", "https://"), false],
        [plain.replace("http://", "HTTP://"), false],
        [`http://${place().toUpperCase()}X:${port()}`, false],
        [`http://${place()}`, false],
        [`http://${place()}:${port()}${pick(["0", "00", "1"])}23456`, false],
        [`http://user@${place()}:${port()}`, false],
        [`ws://${place()}:${port()}`, false],
        ["*", false],
        ["'self'", false],
        ["'unsafe-eval'", false],
        ["data:", false],
        ["http:", false],
        ["", false],
        [" ", false],
      ])
    }
    let plains = 0
    let others = 0
    for (let n = 0; n < 300; n++) {
      const drawn = Array.from({ length: Math.floor(draw() * 6) }, entry)
      pages.now = drawn.map(([value]) => value)
      const page = await fetch(`http://${Listener.HOSTNAME}:${served.port}/`)
      const directives = String(page.headers.get("content-security-policy")).split("; ")
      const want = ["'self'", ...drawn.flatMap(([value, plain]) => Option.toArray(Option.liftPredicate(value, () => plain)))]
      expect({ status: page.status, rest: directives.filter((each) => !each.startsWith("connect-src ")), connect: directives.filter((each) => each.startsWith("connect-src ")) }, JSON.stringify(pages.now)).toEqual({
        status: 200,
        rest: DIRECTIVES,
        connect: [`connect-src ${want.join(" ")}`],
      })
      plains += drawn.filter(([, plain]) => plain).length
      others += drawn.filter(([, plain]) => !plain).length
    }
    expect(Math.min(plains, others)).toBeGreaterThan(50)
  }, 60_000)
})

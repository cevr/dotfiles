// A generated property over the network's faults, on the simulated host at 20
// seeds: two paired hosts (sim/hosts.ts), each with the mail plugin listening
// on a memory network that keeps the real network's laws, two sessions on
// each, and the seed choosing up to 30 commands: a session messages another
// (on its host or the other), a host cut off the network or put back, a host
// whose answers are lost on the way back or not, a reload of a host's plugins
// (its listener closes and binds again), a replay of the last parcel a host
// sent, and time passing; one send in three has its addressee's host reload
// while the parcel is on its way (before it is signed, in flight, or after).
//
// After each command, every session at rest: a letter is held at most once,
// and only by the session it was sent to; a receipt that says delivered names
// the session that holds it, once; a send on a sound network (nothing cut,
// no answer lost) to another session is delivered; a send to another session
// whose hosts are not cut off is held exactly once, across reloads, replays
// and lost answers; no pairing secret reaches a model. Each seed runs twice
// and the two runs' traces are byte-equal.
import { describe } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import { DEFAULT_PORT, ROUTES } from "@dotfiles/opencode-mail/peer"
import * as Hosts from "../../sim/hosts.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Read from "../../sim/readings.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

/**
 * Seeds a wider sweep (21 to 400) found failing, replayed on every run: a parcel replayed after the receiving host's
 * reload was taken again, its nonce forgotten with the listener that saw it (fixed in mods/mail/http/listener.ts).
 * Then 6, 79, 91, 100 (1 to 120) and 160, 212 (to 500): a parcel signed before its addressee's reload, refused by
 * the new listener (or its refusal or answer lost), was never held; and 385 (to 400) without the resend (the sender
 * signs again and sends again, and the receiving host holds a parcel once by its id: mods/mail/http/peers.ts,
 * mods/mail/model.ts).
 */
const PAST = [46, 61, 84, 101, 113, 6, 79, 91, 100, 160, 212, 385]

const { seeded } = Seed.runner("cmd/mail/mail-faults.sim.test.ts", { past: PAST })

const WORK = "/scratch/work"
const HOSTS = ["mac", "workbox"] as const
type HostName = (typeof HOSTS)[number]
const ADDRESS: Record<HostName, string> = { mac: "100.64.0.1", workbox: "100.64.0.2" }
const OTHER: Record<HostName, HostName> = { mac: "workbox", workbox: "mac" }
const SECRET = "k".repeat(43)

type Command =
  | { readonly type: "send"; readonly from: number; readonly to: number; readonly reloadAfter: Option.Option<number> }
  | { readonly type: "cut"; readonly host: HostName; readonly off: boolean }
  | { readonly type: "lose"; readonly host: HostName; readonly losing: boolean }
  | { readonly type: "reload"; readonly host: HostName }
  | { readonly type: "replay"; readonly host: HostName }
  | { readonly type: "advance"; readonly ms: number }

type Random = ReturnType<typeof generator>

/** Whether the addressee's host reloads while a send is on its way, and how many ms after the prompt: one send in three. */
const reloadOf = (during: Random): Option.Option<number> => Option.liftPredicate(below(during, 700), () => below(during, 3) === 0)

const commandOf = (pick: number, random: Random, during: Random): Command => {
  const host = HOSTS[below(random, 2)] ?? "mac"
  if (pick < 8) return { type: "send", from: below(random, 4), to: below(random, 4), reloadAfter: reloadOf(during) }
  if (pick < 10) return { type: "cut", host, off: below(random, 2) === 0 }
  if (pick < 12) return { type: "lose", host, losing: below(random, 2) === 0 }
  if (pick < 13) return { type: "reload", host }
  if (pick < 14) return { type: "replay", host }
  return { type: "advance", ms: 1_000 * below(random, 60) }
}

/**
 * Up to 30 commands, the seed choosing each. Whether a send's addressee reloads on the way is drawn from a stream of its
 * own, so the commands a seed chose before that was drawn stay the same (PAST keeps replaying what it found).
 */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`mail-faults:${seed}`)
  const during = generator(`mail-faults:${seed}:reload-during`)
  return Array.from({ length: 10 + below(random, 21) }, () => commandOf(below(random, 15), random, during))
}

/** The model: a user's `mail-send <id> <text>` messages that id; anything else (a tool's result, a letter) closes the turn. */
const model =
  (worlds: ReadonlyMap<HostName, World.World>, host: HostName): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Mail")
    const said = Read.last(Option.fromNullishOr(worlds.get(host)), request.sessionID).pipe(Option.filter((spoken) => spoken.role === "user"))
    const to = Option.flatMap(said, (spoken) => Read.group(/mail-send (ses_[A-Za-z0-9]+) \S+/, spoken.text))
    const text = Option.flatMap(said, (spoken) => Read.group(/mail-send ses_[A-Za-z0-9]+ (\S+)/, spoken.text))
    return Option.match(Option.all([to, text]), {
      onNone: () => World.say("done"),
      onSome: ([id, tag]) => World.call(`call_${tag}`, "message", { to: id, text: tag }),
    })
  }

/** A host's pairing as the pair command leaves it: its name, and the other host with the secret both hold. */
const paired = (name: HostName, other: HostName) =>
  MemoryPairs.make({ name, peers: { [other]: { url: `http://${ADDRESS[other]}:${DEFAULT_PORT}`, secret: SECRET, paired: World.START } }, invites: [] })

interface Session {
  readonly host: HostName
  readonly id: string
}

interface Letter {
  readonly tag: string
  readonly to: string
  readonly from: string
  /** Sent with nothing cut and no answer lost. */
  readonly sound: boolean
  /** Neither its sender's host nor its addressee's cut off when sent: the parcel can arrive, an answer lost or not. */
  readonly reachable: boolean
}

/** One run's hosts, network and sessions, and what has been sent and which faults are on. */
interface Run {
  readonly network: MemoryNet.Network
  readonly worlds: ReadonlyMap<HostName, World.World>
  readonly mac: World.World
  readonly sessions: ReadonlyArray<Session>
  readonly cut: Set<HostName>
  readonly lost: Set<HostName>
  readonly sent: Array<Letter>
}

/** Both hosts on one network, the mail plugin listening on each, two sessions on each. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const network = MemoryNet.make({ latencyMs: 20 })
    const worlds = new Map<HostName, World.World>()
    const mac = World.make({ seed, script: model(worlds, "mac"), latency: [100, 400] })
    const workbox = Hosts.beside(mac, { script: model(worlds, "workbox"), latency: [100, 400] })
    worlds.set("mac", mac).set("workbox", workbox)
    for (const [name, world] of worlds)
      yield* world.load(Plugins.mail(network, paired(name, OTHER[name]), ADDRESS[name]), {
        directory: WORK,
        options: { listen: { hostname: ADDRESS[name] } },
      })
    const sessions: ReadonlyArray<Session> = [
      { host: "mac", id: yield* mac.session(WORK, { title: "Mac one" }) },
      { host: "mac", id: yield* mac.session(WORK, { title: "Mac two" }) },
      { host: "workbox", id: yield* workbox.session(WORK, { title: "Workbox one" }) },
      { host: "workbox", id: yield* workbox.session(WORK, { title: "Workbox two" }) },
    ]
    const run: Run = { network, worlds, mac, sessions, cut: new Set(), lost: new Set(), sent: [] }
    return run
  })

const worldOf = (run: Run, host: HostName) => Option.getOrElse(Option.fromNullishOr(run.worlds.get(host)), () => run.mac)

/** The letters with `tag` each session holds. */
const holding = (run: Run, tag: string) =>
  run.sessions.map(
    (session) =>
      worldOf(run, session.host)
        .messages(session.id)
        .filter((message) => message.type === "synthetic" && message.text.endsWith(`\n${tag}`)).length,
  )

/** Whether the sender's message tool said the letter was delivered. */
const delivered = (run: Run, tag: string) =>
  run.sessions
    .flatMap((session) => worldOf(run, session.host).messages(session.id))
    .some((message) => message.type === "tool" && message.callID === `call_${tag}` && !message.error && message.output.startsWith("Delivered"))

/** The invariants, with every session at rest. */
const check = (run: Run, expect: Seed.Seeded["expect"]) => {
  for (const letter of run.sent) {
    const held = holding(run, letter.tag)
    const at = run.sessions.findIndex((session) => session.id === letter.to)
    const own = Option.getOrElse(Option.fromNullishOr(held[at]), () => 0)
    // At most once, and only by the session it was sent to.
    expect({ tag: letter.tag, held: held.filter((count, index) => index !== at && count > 0) }).toEqual({ tag: letter.tag, held: [] })
    expect({ tag: letter.tag, once: own <= 1 }).toEqual({ tag: letter.tag, once: true })
    const receipt = delivered(run, letter.tag)
    if (receipt) expect({ tag: letter.tag, receiptHeld: own }).toEqual({ tag: letter.tag, receiptHeld: 1 })
    if (letter.sound && letter.to !== letter.from) expect({ tag: letter.tag, soundDelivered: receipt }).toEqual({ tag: letter.tag, soundDelivered: true })
    // A parcel that can arrive is held exactly once, whatever reloads, replays or lost answers came between.
    if (letter.reachable && letter.to !== letter.from) expect({ tag: letter.tag, heldOnce: own }).toEqual({ tag: letter.tag, heldOnce: 1 })
  }
  const requests = [...run.worlds.values()].flatMap((world) => world.asked().map((asked) => asked.text)).join("\n")
  expect(requests.includes(SECRET)).toBe(false)
}

/**
 * A session messages another, the letter tagged by the command's index; with `reloadAfter`, the addressee's host
 * reloads that many ms after the prompt, before, while or after the parcel is on its way.
 */
const send = (run: Run, index: number, from: Session, to: Session, reloadAfter: Option.Option<number>) => {
  const tag = `letter${index}`
  const reachable = from.host === to.host || (!run.cut.has(from.host) && !run.cut.has(to.host))
  run.sent.push({ tag, to: to.id, from: from.id, sound: run.cut.size === 0 && run.lost.size === 0, reachable })
  const prompted = worldOf(run, from.host).prompt(from.id, `mail-send ${to.id} ${tag}`)
  return Option.match(reloadAfter, {
    onNone: () => prompted,
    onSome: (ms) => prompted.pipe(Effect.andThen(run.mac.advance(ms)), Effect.andThen(worldOf(run, to.host).restart)),
  })
}

/** A fault on or off, on the network and in the run's record. */
const fault = (faults: Set<HostName>, host: HostName, on: boolean) => {
  if (on) faults.add(host)
  else faults.delete(host)
}

/** The host posts again the last parcel it sent, headers and all. */
const replay = (run: Run, host: HostName) =>
  Option.match(Option.fromNullishOr(run.network.sent().filter((request) => request.from === ADDRESS[host] && request.url.endsWith(ROUTES.receive)).at(-1)), {
    onNone: () => Effect.void,
    onSome: (last) => Hosts.command(worldOf(run, host), run.network.net(ADDRESS[host]).post(last.url, { headers: last.headers, body: last.body }, 10_000)),
  })

const apply = (run: Run, index: number, command: Command): Effect.Effect<unknown, World.SimError> => {
  switch (command.type) {
    case "send":
      return Option.match(Option.all([Option.fromNullishOr(run.sessions[command.from]), Option.fromNullishOr(run.sessions[command.to])]), {
        onNone: () => Effect.void,
        onSome: ([from, to]) => send(run, index, from, to, command.reloadAfter),
      })
    case "cut":
      return Effect.sync(() => {
        run.network.cut(ADDRESS[command.host], command.off)
        fault(run.cut, command.host, command.off)
      })
    case "lose":
      return Effect.sync(() => {
        run.network.lose(ADDRESS[command.host], command.losing)
        fault(run.lost, command.host, command.losing)
      })
    case "reload":
      return worldOf(run, command.host).restart
    case "replay":
      return replay(run, command.host)
    case "advance":
      return run.mac.advance(command.ms)
  }
}

/** One run of `commands` on `seed`, checked after each: both hosts' traces. */
const run = (seed: number, commands: ReadonlyArray<Command>, expect: Seed.Seeded["expect"]) =>
  Effect.gen(function* () {
    const state = yield* boot(seed)
    const rest = () => state.sessions.every((session) => Read.idle(worldOf(state, session.host), session.id))
    for (const [index, command] of commands.entries()) {
      yield* apply(state, index, command)
      // A reload's listener binds again within its retry: the wait lets it.
      yield* state.mac.until(rest, 10 * 60_000, 100)
      check(state, expect)
    }
    return [...state.worlds.values()].map((world) => world.trace()).join("\n----\n")
  })

const Refusal = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }))

describe("session mail over a faulty network", () => {
  seeded("a parcel replayed after the receiving host's reload is refused, and its letter is held once", ({ seed, expect }) =>
    Effect.gen(function* () {
      const network = MemoryNet.make({ latencyMs: 20 })
      const worlds = new Map<HostName, World.World>()
      const mac = World.make({ seed, script: model(worlds, "mac") })
      const workbox = Hosts.beside(mac, { script: () => World.say("read") })
      worlds.set("mac", mac).set("workbox", workbox)
      yield* mac.load(Plugins.mail(network, paired("mac", "workbox"), ADDRESS.mac), { directory: WORK, options: { listen: { hostname: ADDRESS.mac } } })
      yield* workbox.load(Plugins.mail(network, paired("workbox", "mac"), ADDRESS.workbox), { directory: WORK, options: { listen: { hostname: ADDRESS.workbox } } })
      const target = yield* workbox.session(WORK, { title: "Workbox one" })
      const sender = yield* mac.session(WORK, { title: "Mac one" })
      yield* mac.prompt(sender, `mail-send ${target} replayed`)
      yield* mac.until(() => Read.synthetic(workbox, target, "mail").length > 0, 60_000)
      const parcel = Option.fromNullishOr(network.sent().filter((request) => request.url.endsWith(ROUTES.receive)).at(-1))
      expect(Option.isSome(parcel)).toBe(true)
      yield* workbox.restart
      yield* mac.advance(1_000)
      const replayed = yield* Option.match(parcel, {
        onNone: () => Effect.succeed({ status: 0, body: '{"reason":"nothing sent"}' }),
        onSome: (sent) => Hosts.run(mac, network.net(ADDRESS.mac).post(sent.url, { headers: sent.headers, body: sent.body }, 10_000)),
      })
      expect([replayed.status, Schema.decodeUnknownSync(Refusal)(replayed.body)]).toEqual([401, { reason: "the request was signed before this listener started" }])
      expect(Read.synthetic(workbox, target, "mail")).toHaveLength(1)
    }),
  )

  seeded("a parcel that got no answer is sent again, and its letter is held once with a delivered receipt", ({ seed, expect }) =>
    Effect.gen(function* () {
      const network = MemoryNet.make({ latencyMs: 20 })
      const worlds = new Map<HostName, World.World>()
      const mac = World.make({ seed, script: model(worlds, "mac") })
      const workbox = Hosts.beside(mac, { script: () => World.say("read") })
      worlds.set("mac", mac).set("workbox", workbox)
      yield* mac.load(Plugins.mail(network, paired("mac", "workbox"), ADDRESS.mac), { directory: WORK, options: { listen: { hostname: ADDRESS.mac } } })
      yield* workbox.load(Plugins.mail(network, paired("workbox", "mac"), ADDRESS.workbox), { directory: WORK, options: { listen: { hostname: ADDRESS.workbox } } })
      const target = yield* workbox.session(WORK, { title: "Workbox one" })
      const sender = yield* mac.session(WORK, { title: "Mac one" })
      const parcels = () => network.sent().filter((request) => request.url.endsWith(ROUTES.receive))
      // The first try goes to a workbox cut off the wire: it never arrives, and no answer comes.
      network.cut(ADDRESS.workbox, true)
      yield* mac.prompt(sender, `mail-send ${target} resent`)
      yield* mac.until(() => parcels().length > 0, 60_000, 10)
      // Past its latency, the first try is lost on the cut wire; then the workbox is back.
      yield* mac.advance(1_000)
      network.cut(ADDRESS.workbox, false)
      yield* mac.until(() => Read.idle(mac, sender) && Read.synthetic(workbox, target, "mail").length > 0, 60_000)
      expect(parcels().length).toBeGreaterThanOrEqual(2)
      expect(Read.synthetic(workbox, target, "mail")).toHaveLength(1)
      expect(Read.answers(mac, sender, "message")).toEqual([`Delivered to session "Workbox one" (${target}) on host workbox. It was idle and is now reading it.`])
    }),
  )

  seeded("a letter is held at most once, by its addressee; a delivered receipt is true; a sound network delivers; no secret reaches a model", ({ seed, expect }) =>
    Effect.gen(function* () {
      const commands = commandsOf(seed)
      const first = yield* run(seed, commands, expect)
      const second = yield* run(seed, commands, expect)
      expect(second === first).toBe(true)
    }),
  )
})

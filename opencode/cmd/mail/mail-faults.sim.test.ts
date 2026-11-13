// A generated property over the network's faults, on the simulated host at 20
// seeds: two paired hosts (sim/hosts.ts), each with the mail plugin listening
// on a memory network that keeps the real network's laws, two sessions on
// each, and the seed choosing up to 30 commands: a session messages another
// (on its host or the other), a host cut off the network or put back, a host
// whose answers are lost on the way back or not, a reload of a host's plugins
// (its listener closes and binds again), a replay of the last parcel a host
// sent, and time passing.
//
// After each command, every session at rest: a letter is held at most once,
// and only by the session it was sent to; a receipt that says delivered names
// the session that holds it, once; a send on a sound network (nothing cut,
// no answer lost) to another session is delivered; no pairing secret reaches a
// model. Each seed runs twice and the two runs' traces are byte-equal.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import { DEFAULT_PORT, ROUTES } from "@dotfiles/opencode-mail/peer"
import * as Hosts from "../../sim/hosts.ts"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

/**
 * Seeds a wider sweep (21 to 400) found failing, replayed on every run: a parcel replayed after the receiving host's
 * reload was taken again, its nonce forgotten with the listener that saw it (fixed in mods/mail/http/listener.ts).
 */
const PAST = [46, 61, 84, 101, 113]

const { seeded } = Seed.runner("cmd/mail/mail-faults.sim.test.ts", { past: PAST })

const WORK = "/scratch/work"
const HOSTS = ["mac", "workbox"] as const
type HostName = (typeof HOSTS)[number]
const ADDRESS: Record<HostName, string> = { mac: "100.64.0.1", workbox: "100.64.0.2" }
const SECRET = "k".repeat(43)

type Command =
  | { readonly type: "send"; readonly from: number; readonly to: number }
  | { readonly type: "cut"; readonly host: HostName; readonly off: boolean }
  | { readonly type: "lose"; readonly host: HostName; readonly losing: boolean }
  | { readonly type: "reload"; readonly host: HostName }
  | { readonly type: "replay"; readonly host: HostName }
  | { readonly type: "advance"; readonly ms: number }

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  const host = HOSTS[below(random, 2)] ?? "mac"
  if (pick < 8) return { type: "send", from: below(random, 4), to: below(random, 4) }
  if (pick < 10) return { type: "cut", host, off: below(random, 2) === 0 }
  if (pick < 12) return { type: "lose", host, losing: below(random, 2) === 0 }
  if (pick < 13) return { type: "reload", host }
  if (pick < 14) return { type: "replay", host }
  return { type: "advance", ms: 1_000 * below(random, 60) }
}

/** Up to 30 commands, the seed choosing each. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`mail-faults:${seed}`)
  return Array.from({ length: 10 + below(random, 21) }, () => commandOf(below(random, 15), random))
}

/** The model: `mail-send <id> <text>` last messages that id; a tool's result or a letter closes the turn. */
const model =
  (host: { world?: World.World }): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Mail")
    const last = Option.fromNullishOr(host.world?.context(request.sessionID).at(-1))
    const send = Option.flatMap(last, (message) =>
      Option.fromNullishOr(message.type === "user" ? /mail-send (ses_[A-Za-z0-9]+) (\S+)/.exec(message.text) : null),
    )
    return Option.match(send, {
      onNone: () => World.say("done"),
      onSome: (match) => World.call(`call_${match[2]}`, "message", { to: match[1] ?? "", text: match[2] ?? "" }),
    })
  }

/** A host's pairing as the pair command leaves it: its name, and the other host with the secret both hold. */
const paired = (name: HostName, other: HostName) =>
  MemoryPairs.make({ name, peers: { [other]: { url: `http://${ADDRESS[other]}:${DEFAULT_PORT}`, secret: SECRET, paired: World.START } }, invites: [] })

/** One run of `commands` on `seed`: both hosts' traces. */
const run = (seed: number, commands: ReadonlyArray<Command>, expect: Seed.Seeded["expect"]) =>
  Effect.gen(function* () {
    const network = MemoryNet.make({ latency: Effect.sleep("20 millis") })
    const holders: Record<HostName, { world?: World.World }> = { mac: {}, workbox: {} }
    const mac = World.make({ seed, script: model(holders.mac), latency: [100, 400] })
    const workbox = Hosts.beside(mac, { script: model(holders.workbox), latency: [100, 400] })
    const worlds: Record<HostName, World.World> = { mac, workbox }
    holders.mac.world = mac
    holders.workbox.world = workbox
    const pairs: Record<HostName, MemoryPairs.MemoryPairs> = { mac: paired("mac", "workbox"), workbox: paired("workbox", "mac") }
    for (const name of HOSTS) yield* worlds[name].load(Plugins.mail(network, pairs[name], ADDRESS[name]), { directory: WORK, options: { listen: { hostname: ADDRESS[name] } } })
    const sessions: ReadonlyArray<{ readonly host: HostName; readonly id: string }> = [
      { host: "mac", id: yield* mac.session(WORK, { title: "Mac one" }) },
      { host: "mac", id: yield* mac.session(WORK, { title: "Mac two" }) },
      { host: "workbox", id: yield* workbox.session(WORK, { title: "Workbox one" }) },
      { host: "workbox", id: yield* workbox.session(WORK, { title: "Workbox two" }) },
    ]
    const faults = { cut: new Set<HostName>(), lost: new Set<HostName>() }
    const sent: Array<{ readonly tag: string; readonly to: string; readonly from: string; readonly sound: boolean }> = []
    const rest = () => sessions.every((session) => worlds[session.host].sessions.get(session.id)?.running !== true)
    const settle = mac.until(rest, 10 * 60_000, 100)

    /** The letters with `tag` each session holds. */
    const holding = (tag: string) =>
      sessions.map(
        (session) =>
          worlds[session.host].messages(session.id).filter((message) => message.type === "synthetic" && message.text.endsWith(`\n${tag}`)).length,
      )
    const receiptOf = (from: string, tag: string) =>
      Option.fromNullishOr(
        sessions
          .flatMap((session) => worlds[session.host].messages(session.id))
          .find((message) => message.type === "tool" && message.callID === `call_${tag}` && from !== ""),
      )

    const check = () => {
      for (const letter of sent) {
        const held = holding(letter.tag)
        const at = sessions.findIndex((session) => session.id === letter.to)
        // At most once, and only by the session it was sent to.
        expect({ tag: letter.tag, held: held.filter((count, index) => index !== at && count > 0) }).toEqual({ tag: letter.tag, held: [] })
        expect({ tag: letter.tag, once: (held[at] ?? 0) <= 1 }).toEqual({ tag: letter.tag, once: true })
        const receipt = receiptOf(letter.from, letter.tag)
        const delivered = Option.exists(receipt, (message) => message.type === "tool" && !message.error && message.output.startsWith("Delivered"))
        if (delivered) expect({ tag: letter.tag, receiptHeld: held[at] }).toEqual({ tag: letter.tag, receiptHeld: 1 })
        if (letter.sound && letter.to !== letter.from) expect({ tag: letter.tag, soundDelivered: delivered }).toEqual({ tag: letter.tag, soundDelivered: true })
      }
      const requests = [...mac.asked(), ...workbox.asked()].map((asked) => asked.text).join("\n")
      expect(requests.includes(SECRET)).toBe(false)
    }

    for (const [index, command] of commands.entries()) {
      if (command.type === "send") {
        const from = sessions[command.from] ?? sessions[0]
        const to = sessions[command.to] ?? sessions[0]
        const tag = `letter${index}`
        const sound = faults.cut.size === 0 && faults.lost.size === 0
        sent.push({ tag, to: to?.id ?? "", from: from?.id ?? "", sound })
        yield* worlds[from?.host ?? "mac"].prompt(from?.id ?? "", `mail-send ${to?.id} ${tag}`)
      }
      if (command.type === "cut") {
        network.cut(ADDRESS[command.host], command.off)
        if (command.off) faults.cut.add(command.host)
        else faults.cut.delete(command.host)
      }
      if (command.type === "lose") {
        network.lose(ADDRESS[command.host], command.losing)
        if (command.losing) faults.lost.add(command.host)
        else faults.lost.delete(command.host)
      }
      if (command.type === "reload") yield* worlds[command.host].restart
      if (command.type === "replay") {
        const last = network
          .sent()
          .filter((request) => request.from === ADDRESS[command.host] && request.url.endsWith(ROUTES.receive))
          .at(-1)
        if (last !== undefined)
          yield* Hosts.command(worlds[command.host], network.net(ADDRESS[command.host]).post(last.url, { headers: last.headers, body: last.body }, 10_000))
      }
      if (command.type === "advance") yield* mac.advance(command.ms)
      yield* settle
      // A reload's listener binds again within its retry: let it.
      check()
    }
    return `${mac.trace()}\n----\n${workbox.trace()}`
  })

describe("session mail over a faulty network", () => {
  seeded("a parcel replayed after the receiving host's reload is refused, and its letter is held once", ({ seed, expect }) =>
    Effect.gen(function* () {
      const network = MemoryNet.make({ latency: Effect.sleep("20 millis") })
      const holder: { world?: World.World } = {}
      const mac = World.make({ seed, script: model(holder) })
      holder.world = mac
      const workbox = Hosts.beside(mac, { script: () => World.say("read") })
      const pairs = { mac: paired("mac", "workbox"), workbox: paired("workbox", "mac") }
      yield* mac.load(Plugins.mail(network, pairs.mac, ADDRESS.mac), { directory: WORK, options: { listen: { hostname: ADDRESS.mac } } })
      yield* workbox.load(Plugins.mail(network, pairs.workbox, ADDRESS.workbox), { directory: WORK, options: { listen: { hostname: ADDRESS.workbox } } })
      const target = yield* workbox.session(WORK, { title: "Workbox one" })
      const sender = yield* mac.session(WORK, { title: "Mac one" })
      yield* mac.prompt(sender, `mail-send ${target} replayed`)
      yield* mac.until(() => workbox.messages(target).some((message) => message.type === "synthetic"), 60_000)
      const parcel = network.sent().filter((request) => request.url.endsWith(ROUTES.receive)).at(-1)
      expect(parcel).toBeDefined()
      yield* workbox.restart
      yield* mac.advance(1_000)
      const replayed = yield* Hosts.run(mac, network.net(ADDRESS.mac).post(parcel?.url ?? "", { headers: parcel?.headers ?? {}, body: parcel?.body ?? "" }, 10_000))
      expect([replayed.status, replayed.body]).toEqual([401, JSON.stringify({ reason: "the request was signed before this listener started" })])
      expect(workbox.messages(target).filter((message) => message.type === "synthetic")).toHaveLength(1)
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

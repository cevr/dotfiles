// Session mail between two paired OpenCode servers on the simulated host, at
// 20 seeds: tests/mail-peer.test.ts's name and the claims it reads off the
// model's requests and the pairing, moved off two real servers. Each host is a
// world of its own on one clock (sim/hosts.ts), the mail plugin
// (`cmd/mail/server.ts`'s `make`, sim/plugins.ts `mail`) listening on its
// address of a memory network that keeps the real network's laws
// (mods/mail/http/net-laws.ts). The workbox invites with the pair command's
// own code (`cmd/mail/pair.ts` `pair`), the Mac joins; then the Mac's session
// lists the sessions (the workbox's, marked `on workbox`) and messages a
// workbox session by id; that session wakes on a letter naming the Mac's
// session `on host mac`, and answers it at the id the letter gives, which
// reaches the Mac's session the same way. A request from an unpaired host is
// refused.
//
// What stays real (tests/mail-peer.test.ts): the fork's `serve --service`,
// the pair command as its own process, Bun's server and fetch on loopback, and
// that neither server's password reaches the model.
import { describe } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import * as MemoryTokens from "@dotfiles/opencode-mail/memory/tokens"
import * as Hosts from "../../sim/hosts.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Read from "../../sim/readings.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { type Outcome, pair } from "./pair.ts"

const { seeded } = Seed.runner("cmd/mail/mail-peer.sim.test.ts")

const WORK = "/scratch/work"
/** Each host's tailnet address, where its listener binds. */
const ADDRESS = { mac: "100.64.0.1", workbox: "100.64.0.2", laptop: "100.64.0.9" }
type HostName = "mac" | "workbox"

/** What the last message asks for: the sessions, a message to an id, or the pong to a letter carrying the ping. */
const ask = (text: string): World.Reply => {
  if (text.includes("mail-list")) return World.call("call_list", "sessions", {})
  const send = Read.group(/mail-send (ses_[A-Za-z0-9]+)/, text)
  if (Option.isSome(send)) return World.call("call_send", "message", { to: send.value, text: Option.getOrElse(Read.group(/mail-send \S+ (\S+)/, text), () => "") })
  if (text.includes("ping-from-mac"))
    return World.call("call_pong", "message", { to: Option.getOrElse(Read.group(/\{ "to": "(ses_[A-Za-z0-9]+)"/, text), () => "nobody"), text: "pong-from-workbox" })
  return World.say("ok")
}

/**
 * tests/mail-peer.test.ts's scripted model, by the conversation's last message: `mail-list` lists the sessions,
 * `mail-send <id> <text>` messages that id, a letter carrying `ping-from-mac` answers its sender
 * `pong-from-workbox`, and anything else (a tool's result, the pong) closes the turn.
 */
const model =
  (worlds: ReadonlyMap<HostName, World.World>, host: HostName): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Mail")
    const said = Option.getOrElse(Read.last(Option.fromNullishOr(worlds.get(host)), request.sessionID), () => ({ role: "user", text: "" }))
    if (said.role === "tool") return World.say("done")
    return ask(said.text)
  }

/** What a pair command printed, or its error. */
const printed = (outcome: Outcome) => {
  if (outcome.ok) return outcome.out
  return outcome.error
}

/** Both hosts on one network, each with its pairing, the mail plugin listening on its address. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const network = MemoryNet.make({ latencyMs: 5 })
    const worlds = new Map<HostName, World.World>()
    const mac = World.make({ seed, script: model(worlds, "mac") })
    const workbox = Hosts.beside(mac, { script: model(worlds, "workbox") })
    worlds.set("mac", mac).set("workbox", workbox)
    const pairs = { mac: MemoryPairs.make(), workbox: MemoryPairs.make() }
    yield* mac.load(Plugins.mail(network, pairs.mac, ADDRESS.mac), { directory: WORK, options: { listen: { hostname: ADDRESS.mac } } })
    yield* workbox.load(Plugins.mail(network, pairs.workbox, ADDRESS.workbox), { directory: WORK, options: { listen: { hostname: ADDRESS.workbox } } })
    /** The pair command on a host, as its owner runs it there: `--name` its own. */
    const command = (host: HostName, ...args: ReadonlyArray<string>) =>
      Hosts.run(
        { mac, workbox }[host],
        pair([...args, "--name", host], "cmd/mail/pair.ts").pipe(Effect.provide(Layer.mergeAll(pairs[host].layer, network.layer(ADDRESS[host]), MemoryTokens.layer))),
      )
    return { network, mac, workbox, pairs, command }
  })

const Refusal = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }))

/** Whether a host's listener has recorded its address. */
const listening = (pairs: MemoryPairs.MemoryPairs) => Option.isSome(Option.fromNullishOr(pairs.read().url))

describe("session mail between two paired OpenCode servers (real pair command, scripted model)", () => {
  seeded("paired once, a message reaches the other host's session as mail, and its answer comes back the same way", ({ seed, expect }) =>
    Effect.gen(function* () {
      const { network, mac, workbox, pairs, command } = yield* boot(seed)
      const seen = () => [...mac.asked(), ...workbox.asked()].map((asked) => asked.text)
      const target = yield* workbox.session(WORK, { title: "Workbox PR" })
      const sender = yield* mac.session(WORK, { title: "Mac main" })
      yield* mac.until(() => listening(pairs.mac) && listening(pairs.workbox), 60_000)

      const invite = yield* command("workbox", "invite")
      expect(invite.ok).toBe(true)
      const join = /pair\.ts join (\S+) (\S+)/.exec(printed(invite))
      expect(join).not.toBeNull()
      const [url, code] = [Read.group(/pair\.ts join (\S+)/, printed(invite)), Read.group(/pair\.ts join \S+ (\S+)/, printed(invite))].map((found) => Option.getOrElse(found, () => ""))
      const joined = yield* command("mac", "join", url, code)
      expect([joined.ok, printed(joined).trim()]).toEqual([true, `Paired: this host is mac; workbox is at ${url}.`])

      // The Mac lists the sessions: the workbox's is there, marked with its host.
      yield* mac.prompt(sender, "mail-list")
      yield* mac.until(() => Read.idle(mac, sender), 60_000)
      expect(seen().some((request) => request.includes(`${target} "Workbox PR" · idle`) && request.includes("on workbox"))).toBe(true)

      // The Mac messages it by id; the workbox session wakes on a letter from the Mac's.
      const delivered = (request: string) => request.includes(`Delivered to session "Workbox PR" (${target}) on host workbox.`)
      yield* mac.prompt(sender, `mail-send ${target} ping-from-mac`)
      yield* mac.until(() => seen().some(delivered), 60_000)
      expect(seen().some(delivered)).toBe(true)
      const pinged = (request: string) => request.includes("ping-from-mac") && request.includes("✉ Message from session")
      yield* mac.until(() => seen().some(pinged), 60_000)
      const letter = seen().find(pinged)
      expect(letter).toContain(`✉ Message from session "Mac main" (${sender}) on host mac, sent with the message tool. It is not the user speaking.`)
      expect(letter).toContain(`To answer, call the message tool with { "to": "${sender}", "text": "…" }`)

      // The workbox session answers at that id; it reaches the Mac's session, which wakes on it.
      const answered = (request: string) => request.includes("pong-from-workbox") && request.includes(`✉ Message from session "Workbox PR" (${target}) on host workbox`)
      yield* mac.until(() => seen().some(answered) && Read.idle(mac, sender) && Read.idle(workbox, target), 60_000)
      const pong = seen().find(answered)
      expect(pong).toContain("mail-send")
      expect(seen().some((request) => request.includes(`Delivered to session "Mac main" (${sender}) on host mac.`))).toBe(true)

      // A host it never paired with is refused at the listener.
      const listener = Option.getOrElse(Option.fromNullishOr(pairs.workbox.read().url), () => "")
      const stranger = yield* Hosts.run(
        workbox,
        network.net(ADDRESS.laptop).post(
          `${listener}/mail/v1/list`,
          { headers: { "x-mail-peer": "laptop", "x-mail-time": `${mac.now()}`, "x-mail-nonce": "n".repeat(22), "x-mail-signature": "x" }, body: '{"children":false}' },
          10_000,
        ),
      )
      expect([stranger.status, Schema.decodeUnknownSync(Refusal)(stranger.body)]).toEqual([401, { reason: '"laptop" is not paired with this host' }])

      // Neither host's secret shows in what the models read.
      const secret = Option.getOrElse(
        Option.map(Option.fromNullishOr(pairs.mac.read().peers["workbox"]), (peer) => peer.secret),
        () => "",
      )
      expect(secret.length).toBeGreaterThan(20)
      expect(seen().join("\n")).not.toContain(secret)
    }),
  )
})

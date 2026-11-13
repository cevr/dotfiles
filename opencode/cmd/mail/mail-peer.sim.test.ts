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
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { pair } from "./pair.ts"

const { seeded } = Seed.runner("cmd/mail/mail-peer.sim.test.ts")

const WORK = "/scratch/work"
/** Each host's tailnet address, where its listener binds. */
const ADDRESS = { mac: "100.64.0.1", workbox: "100.64.0.2", laptop: "100.64.0.9" }

/** The id a letter's header says to answer. */
const replyID = (text: string) => /\{ "to": "(ses_[A-Za-z0-9]+)"/.exec(text)?.[1]

/** What a message holds, as the model reads it. */
const textOf = (message: World.Message) => {
  switch (message.type) {
    case "tool":
      return { role: "tool", text: message.output }
    case "assistant":
      return { role: "assistant", text: message.text }
    case "user":
    case "synthetic":
      return { role: "user", text: message.text }
    default:
      return { role: "user", text: "" }
  }
}

/**
 * tests/mail-peer.test.ts's scripted model, by the conversation's last message: `mail-list` lists the sessions,
 * `mail-send <id> <text>` messages that id, a letter carrying `ping-from-mac` answers its sender
 * `pong-from-workbox`, and anything else (a tool's result, the pong) closes the turn.
 */
const model =
  (host: { world?: World.World }): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Mail")
    const last = Option.fromNullishOr(host.world?.context(request.sessionID).at(-1)).pipe(Option.map(textOf))
    const { role, text } = Option.getOrElse(last, () => ({ role: "user", text: "" }))
    if (role === "tool") return World.say("done")
    if (text.includes("mail-list")) return World.call("call_list", "sessions", {})
    const send = /mail-send (ses_[A-Za-z0-9]+) (\S+)/.exec(text)
    if (send !== null) return World.call("call_send", "message", { to: send[1] ?? "", text: send[2] ?? "" })
    if (text.includes("ping-from-mac")) return World.call("call_pong", "message", { to: replyID(text) ?? "nobody", text: "pong-from-workbox" })
    return World.say("ok")
  }

/** Both hosts on one network, each with its pairing, the mail plugin listening on its address. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const network = MemoryNet.make({ latency: Effect.sleep("5 millis") })
    const macHost: { world?: World.World } = {}
    const workboxHost: { world?: World.World } = {}
    const mac = World.make({ seed, script: model(macHost) })
    const workbox = Hosts.beside(mac, { script: model(workboxHost) })
    macHost.world = mac
    workboxHost.world = workbox
    const pairs = { mac: MemoryPairs.make(), workbox: MemoryPairs.make() }
    yield* mac.load(Plugins.mail(network, pairs.mac, ADDRESS.mac), { directory: WORK, options: { listen: { hostname: ADDRESS.mac } } })
    yield* workbox.load(Plugins.mail(network, pairs.workbox, ADDRESS.workbox), { directory: WORK, options: { listen: { hostname: ADDRESS.workbox } } })
    /** The pair command on a host, as its owner runs it there: `--name` its own. */
    const command = (host: "mac" | "workbox", ...args: ReadonlyArray<string>) =>
      Hosts.run(
        { mac, workbox }[host],
        pair([...args, "--name", host], "cmd/mail/pair.ts").pipe(Effect.provide(Layer.mergeAll(pairs[host].layer, network.layer(ADDRESS[host]), MemoryTokens.layer))),
      )
    return { network, mac, workbox, pairs, command }
  })

const Refusal = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }))

describe("session mail between two paired OpenCode servers (real pair command, scripted model)", () => {
  seeded("paired once, a message reaches the other host's session as mail, and its answer comes back the same way", ({ seed, expect }) =>
    Effect.gen(function* () {
      const { network, mac, workbox, pairs, command } = yield* boot(seed)
      const seen = () => [...mac.asked(), ...workbox.asked()].map((asked) => asked.text)
      const target = yield* workbox.session(WORK, { title: "Workbox PR" })
      const sender = yield* mac.session(WORK, { title: "Mac main" })
      const idle = (world: World.World, id: string) => world.sessions.get(id)?.running !== true
      yield* mac.until(() => pairs.mac.read().url !== undefined && pairs.workbox.read().url !== undefined, 60_000)

      const invite = yield* command("workbox", "invite")
      expect(invite.ok).toBe(true)
      const join = /pair\.ts join (\S+) (\S+)/.exec(invite.ok ? invite.out : "")
      expect(join).not.toBeNull()
      const joined = yield* command("mac", "join", join?.[1] ?? "", join?.[2] ?? "")
      expect([joined.ok, joined.ok ? joined.out.trim() : joined.error]).toEqual([true, `Paired: this host is mac; workbox is at ${join?.[1]}.`])

      // The Mac lists the sessions: the workbox's is there, marked with its host.
      yield* mac.prompt(sender, "mail-list")
      yield* mac.until(() => idle(mac, sender), 60_000)
      expect(seen().some((request) => request.includes(`${target} "Workbox PR" · idle`) && request.includes("on workbox"))).toBe(true)

      // The Mac messages it by id; the workbox session wakes on a letter from the Mac's.
      yield* mac.prompt(sender, `mail-send ${target} ping-from-mac`)
      yield* mac.until(() => seen().some((request) => request.includes(`Delivered to session "Workbox PR" (${target}) on host workbox.`)), 60_000)
      expect(seen().some((request) => request.includes(`Delivered to session "Workbox PR" (${target}) on host workbox.`))).toBe(true)
      yield* mac.until(() => seen().some((request) => request.includes("ping-from-mac") && request.includes("✉ Message from session")), 60_000)
      const letter = seen().find((request) => request.includes("ping-from-mac") && request.includes("✉ Message from session"))
      expect(letter).toContain(`✉ Message from session "Mac main" (${sender}) on host mac, sent with the message tool. It is not the user speaking.`)
      expect(letter).toContain(`To answer, call the message tool with { "to": "${sender}", "text": "…" }`)

      // The workbox session answers at that id; it reaches the Mac's session, which wakes on it.
      const answered = (request: string) => request.includes("pong-from-workbox") && request.includes(`✉ Message from session "Workbox PR" (${target}) on host workbox`)
      yield* mac.until(() => seen().some(answered) && idle(mac, sender) && idle(workbox, target), 60_000)
      const pong = seen().find(answered)
      expect(pong).toContain("mail-send")
      expect(seen().some((request) => request.includes(`Delivered to session "Mac main" (${sender}) on host mac.`))).toBe(true)

      // A host it never paired with is refused at the listener.
      const listener = pairs.workbox.read().url ?? ""
      const stranger = yield* Hosts.run(
        workbox,
        network.net(ADDRESS.laptop).post(
          `${listener}/mail/v1/list`,
          { headers: { "x-mail-peer": "laptop", "x-mail-time": String(mac.now()), "x-mail-nonce": "n".repeat(22), "x-mail-signature": "x" }, body: '{"children":false}' },
          10_000,
        ),
      )
      expect([stranger.status, Schema.decodeUnknownSync(Refusal)(stranger.body)]).toEqual([401, { reason: '"laptop" is not paired with this host' }])

      // Neither host's secret shows in what the models read.
      const secret = pairs.mac.read().peers["workbox"]?.secret ?? ""
      expect(secret.length).toBeGreaterThan(20)
      expect(seen().join("\n")).not.toContain(secret)
    }),
  )
})

// Session mail on the simulated host (sim/world.ts), at 20 seeds:
// tests/mail.test.ts's name and the claims it reads off the model's requests
// and the transcripts, moved off real OpenCode. The plugin is
// `cmd/mail/server.ts`'s `make` on the world's plugin context (sim/plugins.ts
// `mail`); the model answers by scenarios/mail.ts's rules, by the words each
// session's conversation holds. A pings an idle B, which wakes and answers A
// at the id its letter names; then A steers a message into C while C runs, and
// C's next model request carries it.
//
// Where the scenario holds C's model request open, C here runs a tool that
// holds for 30 s (`hold`, a plugin of this file's), so C is running when A
// writes. B looks at the sessions before it answers, and the model answers
// within 100 to 190 ms, so A's turn has ended when B's answer comes, as it has
// in the real run, where the model answers at once. What the TUI draws (the
// letter's notice row in A's transcript) stays in tests/mail.test.ts.
import { describe } from "bun:test"
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/mail/mail.sim.test.ts")

const WORK = "/scratch/project"

/** The id the letter's header says to answer. */
const replyID = (text: string) => /\{ "to": "(ses_[A-Za-z0-9]+)"/.exec(text)?.[1]

/** scenarios/mail.ts's model, by the session the conversation is: A, B or C. */
const model: World.Script = (request) => {
  const s = request.text
  if (request.kind === "title") return World.say("Untitled")
  if (s.includes("mail-start-a")) {
    if (s.includes("mail-steer-a")) {
      if (s.includes("call_steer")) return World.say("A steered C")
      const c = /mail-steer-a (ses_[A-Za-z0-9]+)/.exec(s)?.[1]
      if (c === undefined) return World.say("No session id for C")
      return World.call("call_steer", "message", { to: c, text: "mail-steer-text" })
    }
    if (s.includes("mail-pong")) return World.say("A got the pong")
    if (s.includes("call_ping")) return World.say("A sent the ping")
    if (!s.includes("call_list")) return World.call("call_list", "sessions", {})
    if (!/ses_[A-Za-z0-9]+ "Mail B"/.test(s)) return World.say("No Mail B in the listing")
    return World.call("call_ping", "message", { to: "Mail B", text: "mail-ping: answer me" })
  }
  if (s.includes("mail-start-c")) {
    if (s.includes("call_c_hold")) return World.say(s.includes("mail-steer-text") ? "C read the steer" : "C missed the steer")
    return World.call("call_c_hold", "hold", {})
  }
  if (s.includes("call_pong")) return World.say("B answered")
  if (!s.includes("call_look")) return World.call("call_look", "sessions", {})
  const a = replyID(s)
  if (a === undefined) return World.say("No reply id in the letter")
  return World.call("call_pong", "message", { to: a, text: "mail-pong" })
}

/** A tool that runs for 30 s: the session that calls it is running all that time. */
const holder = Plugin.define({
  id: "dotfiles-opencode.sim-hold",
  effect: (ctx) =>
    ctx.tool.transform((editor) => {
      editor.add({
        name: "hold",
        description: "holds the session for 30 s",
        input: Schema.Struct({}),
        execute: () => Effect.sleep("30 seconds").pipe(Effect.as({ content: "held" })),
      })
    }),
})

const requestsOf = (world: World.World, sessionID: string) => world.asked().filter((asked) => asked.sessionID === sessionID && asked.kind === "primary").map((asked) => asked.text)

/** The text the `message` tool answered with, in order. */
const receipts = (world: World.World, sessionID: string) =>
  world.messages(sessionID).flatMap((message) => (message.type === "tool" && message.name === "message" ? [message.output] : []))

/** The letters a session holds: their notice line and sender. */
const letters = (world: World.World, sessionID: string) =>
  world.messages(sessionID).flatMap((message) => (message.type === "synthetic" && message.metadata["source"] === "mail" ? [message] : []))

describe("session mail", () => {
  seeded(
    "a message wakes an idle session, which answers its sender, and a running session reads one at its next step",
    ({ seed, expect }) =>
      Effect.gen(function* () {
        const world = World.make({ seed, script: model, latency: [100, 190] })
        yield* world.load(Plugins.mail(MemoryNet.make(), MemoryPairs.make(), "127.0.0.1"), { directory: WORK })
        yield* world.load(holder, { directory: WORK })
        const b = yield* world.session(WORK, { title: "Mail B" })
        const c = yield* world.session(WORK, { title: "Mail C" })
        const a = yield* world.session(WORK, { title: "Mail A" })
        const idle = (id: string) => world.sessions.get(id)?.running !== true
        const texts = () => world.messages(a).flatMap((message) => (message.type === "assistant" && message.text !== "" ? [message.text] : []))

        yield* world.prompt(a, "mail-start-a")
        yield* world.until(() => texts().includes("A got the pong") && idle(a) && idle(b), 60_000)

        // A listed the sessions: B and C by id and title, its own marked.
        const listing = world.messages(a).flatMap((message) => (message.type === "tool" && message.name === "sessions" ? [message.output] : [])).join("\n")
        expect(listing).toContain(`${b} "Mail B" · idle`)
        expect(listing).toContain(`${c} "Mail C"`)
        expect(listing).toMatch(new RegExp(`${a} "Mail A" · running[^\\n]*\\(you\\)`))

        // B, idle, was woken by the ping: its first request is the letter, under a header naming A and how to answer.
        const [bFirst] = requestsOf(world, b)
        expect(bFirst).toContain(`✉ Message from session "Mail A" (${a}), sent with the message tool. It is not the user speaking.`)
        expect(bFirst).toContain(`To answer, call the message tool with { "to": "${a}", "text": "…" }; answer only if it asks for something.`)
        expect(bFirst).toContain("mail-ping: answer me")
        expect(receipts(world, a)[0]).toBe(`Delivered to session "Mail B" (${b}). It was idle and is now reading it.`)
        expect(letters(world, b).map((letter) => [letter.description, letter.metadata["from"]])).toEqual([
          ["from Mail A · mail-ping: answer me", { sessionID: a, title: "Mail A" }],
        ])

        // B answered at that id; A, idle by then, woke and read it.
        expect(receipts(world, b)).toEqual([`Delivered to session "Mail A" (${a}). It was idle and is now reading it.`])
        expect(letters(world, a).map((letter) => letter.description)).toEqual(["from Mail B · mail-pong"])
        expect(texts().slice(0, 2)).toEqual(["A sent the ping", "A got the pong"])

        // The transcript holds the letter between A's turns, as the TUI draws it there.
        const order = world.messages(a).flatMap((message) => {
          if (message.type === "synthetic") return [message.description]
          if (message.type === "assistant" && message.text !== "") return [message.text]
          return []
        })
        expect(order.indexOf("from Mail B · mail-pong")).toBeGreaterThan(order.indexOf("A sent the ping"))
        expect(order.indexOf("from Mail B · mail-pong")).toBeLessThan(order.indexOf("A got the pong"))
        expect(letters(world, a)[0]?.description).not.toContain("It is not the user speaking")

        // C was running when A wrote: the receipt says so, and C's next request, after its held one, carries the letter.
        yield* world.prompt(c, "mail-start-c")
        yield* world.until(() => world.messages(c).some((message) => message.type === "assistant" && Option.isSome(message.call)), 60_000, 10)
        yield* world.prompt(a, `mail-steer-a ${c}`)
        yield* world.until(() => texts().includes("A steered C") && idle(a), 20_000, 10)
        expect(idle(c)).toBe(false)
        expect(receipts(world, a)[1]).toBe(`Delivered to session "Mail C" (${c}). It is running and reads it at its next step.`)
        yield* world.until(() => idle(c), 60_000)
        const [cHeld, cNext] = requestsOf(world, c)
        expect(cHeld).not.toContain("mail-steer-text")
        expect(cNext).toContain("mail-steer-text")
        expect(cNext).toContain(`✉ Message from session "Mail A" (${a})`)
        expect(requestsOf(world, c)).toHaveLength(2)
        expect(JSON.stringify(world.messages(c))).toContain("C read the steer")
      }),
  )
})

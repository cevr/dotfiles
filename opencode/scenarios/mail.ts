// Session mail between three sessions on one server, each on a scripted model,
// with the mail plugin loaded as daily loads it (no kernel, so the tools are
// direct). Session A is the TUI's; B ("Mail B") and C ("Mail C") are made
// through the API.
//
// The exchange: A lists the sessions, finds B and messages it "mail-ping". B
// is idle, so it wakes and reads the letter; it answers A with "mail-pong" at
// the id the letter's header gives. A wakes on the answer and says
// "A got the pong"; its transcript shows `✉ from Mail B · mail-pong`.
//
// The steer: C is prompted and its first model request is held, so C runs.
// A messages C "mail-steer-text" and reads the receipt. C is released, makes
// one tool call, and its next request must carry the letter.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/mail.ts
//
// It writes, under SCENARIO_OUT, `mail-exchange.txt` (the frame after the
// exchange), `mail-steer.txt` (the frame after the steer),
// `mail-timeout.txt` when a wait times out, `mail-requests.json` (each model
// request, by the session it came from) and `mail-transcripts.json` (A's, B's
// and C's messages).
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const step = (id: string, name: string, input: ToolInput) =>
  Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

/** The session a request came from, by the words only that session's conversation holds. */
const sessionOf = (s: string): "A" | "B" | "C" | "title" => {
  if (s.includes("You name conversations")) return "title"
  if (s.includes("mail-start-a")) return "A"
  if (s.includes("mail-start-c")) return "C"
  return "B"
}

/** The id the letter's header says to answer, as the request's JSON escapes it. */
const replyID = (s: string) => /\{ \\"to\\": \\"(ses_[A-Za-z0-9]+)\\"/.exec(s)?.[1]

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/mail`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/mods/prime`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: string; readonly request: string }> = []
      const cStarted = yield* Deferred.make<void>()
      const cRelease = yield* Deferred.make<void>()
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const session = sessionOf(s)
        requests.push({ session, request: s })
        if (session === "title") return say(s.includes("mail-start-a") ? "Mail A" : "Untitled")
        if (session === "A") {
          if (s.includes("mail-steer-a")) {
            if (s.includes("call_steer")) return say("A steered C")
            const c = /mail-steer-a (ses_[A-Za-z0-9]+)/.exec(s)?.[1]
            if (c === undefined) return say("No session id for C")
            return step("call_steer", "message", { to: c, text: "mail-steer-text" })
          }
          if (s.includes("mail-pong")) return say("A got the pong")
          if (s.includes("call_ping")) return say("A sent the ping")
          if (!s.includes("call_list")) return step("call_list", "sessions", {})
          const b = /(ses_[A-Za-z0-9]+) \\"Mail B\\"/.exec(s)?.[1]
          if (b === undefined) return say("No Mail B in the listing")
          return step("call_ping", "message", { to: "Mail B", text: "mail-ping: answer me" })
        }
        if (session === "C") {
          if (s.includes("call_c_list")) return say(s.includes("mail-steer-text") ? "C read the steer" : "C missed the steer")
          // Held: C runs until the scenario lets it go.
          return Stream.fromEffect(Deferred.succeed(cStarted, undefined)).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(cRelease))),
            Stream.drain,
            Stream.concat(step("call_c_list", "sessions", {})),
          )
        }
        if (s.includes("call_pong")) return say("B answered")
        const a = replyID(s)
        if (a === undefined) return say("No reply id in the letter")
        return step("call_pong", "message", { to: a, text: "mail-pong" })
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/mail-timeout.txt`, text(frame))))),
        )
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/mail-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, title: session.title, messages }))),
        )
        writeFileSync(`${out}/mail-transcripts.json`, JSON.stringify(transcripts, null, 2))
      })

      yield* opencode.session.create({ title: "Mail B" })
      const c = yield* opencode.session.create({ title: "Mail C" })

      yield* ui.submit("mail-start-a")
      yield* until((frame) => frame.includes("A got the pong") && frame.includes("✉ from Mail B · mail-pong")).pipe(Effect.tapError(() => dump))
      writeFileSync(`${out}/mail-exchange.txt`, text(yield* ui.capture()))

      yield* opencode.session.prompt({ sessionID: c.id, text: "mail-start-c" })
      yield* Deferred.await(cStarted)
      yield* ui.submit(`mail-steer-a ${c.id}`)
      yield* until((frame) => frame.includes("A steered C")).pipe(Effect.tapError(() => dump))
      writeFileSync(`${out}/mail-steer.txt`, text(yield* ui.capture()))
      yield* Deferred.succeed(cRelease, undefined)
      yield* opencode.session.wait({ sessionID: c.id })
      console.log("screenshot:", yield* ui.screenshot("mail"))
      yield* dump
    }),
)

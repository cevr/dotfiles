// The plugin seam: the composition root on a stand-in host over the memory
// doubles. It checks what OpenCode sees: the tool's answer and refusals, the
// RPC's open list, an answer reaching the asking session (a subagent's too)
// with a `changed` event per change, the /answer form's submit (the host's
// `form.replied`) reaching the session as one message, a refused delivery
// sent at the next start, and a deleted session's questions going.
// tests/questions.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import type { Tool } from "@opencode/plugin/effect"
import { Effect, Layer, Queue, Schedule, Schema, type Scope, Stream } from "effect"
import type { AskInput } from "@dotfiles/opencode-questions/ask"
import * as MemoryCourier from "@dotfiles/opencode-questions/memory/courier"
import * as MemoryStore from "@dotfiles/opencode-questions/memory/store"
import { Open, QUESTIONS, Reply } from "@dotfiles/opencode-questions/question"
import QuestionsPlugin, { make } from "./server.ts"

type Host = Parameters<(typeof QuestionsPlugin)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown>

/** The tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (input: AskInput, context: unknown) => Effect.Effect<{ readonly content: ReadonlyArray<Tool.Content> }, Tool.Error>
}

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** The plugin started on a stand-in host over `sheets` and `sessions`. */
const start = (sheets = MemoryStore.empty(), sessions = MemoryCourier.empty("ses_root", "ses_child")) =>
  Effect.gen(function* () {
    const rpc: Record<string, Record<string, Handler>> = {}
    const emitted: Array<readonly [string, unknown]> = []
    const deletions = yield* Queue.unbounded<{ readonly type: "session.deleted"; readonly data: { readonly sessionID: string } }>()
    const replies = yield* Queue.unbounded<{ readonly type: "form.replied"; readonly data: { readonly id: string; readonly sessionID: string; readonly answer: Record<string, unknown> } }>()
    let added: Added | undefined
    const host = {
      options: {},
      tool: {
        transform: (callback: (editor: { add: (tool: Added) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void (added = tool) })
            return { dispose: Effect.void }
          }),
      },
      event: {
        subscribe: (input: { readonly types: ReadonlyArray<string> }) =>
          input.types.includes("form.replied") ? Stream.fromQueue(replies) : Stream.fromQueue(deletions),
      },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void, events: { emit: (name: string, data: unknown) => Effect.sync(() => void emitted.push([name, data])) } }
          }),
      },
    } as unknown as Host
    yield* make(() => Layer.merge(MemoryStore.layer(sheets), MemoryCourier.layer(sessions))).effect(host)
    const tool = added
    if (tool === undefined) return yield* Effect.die(new Error("the tool was not added"))
    const handlers = rpc[QUESTIONS.id]
    if (handlers === undefined) return yield* Effect.die(new Error(`not registered: ${QUESTIONS.id}`))
    const method = (name: string) => {
      const handler = handlers[name]
      return handler === undefined ? Effect.die(new Error(`no method ${name}`)) : Effect.succeed(handler)
    }
    const execute = (input: AskInput, sessionID = "ses_root") =>
      tool.execute(input, { sessionID, agent: "build", messageID: "msg_1", id: "call_1", progress: () => Effect.void })
    const call = (input: AskInput, sessionID?: string) =>
      execute(input, sessionID).pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")))
    const fail = (input: AskInput, sessionID?: string) => Effect.flip(execute(input, sessionID)).pipe(Effect.map((error) => error.message))
    const open = (...sessionIDs: ReadonlyArray<string>) =>
      method("open").pipe(
        Effect.flatMap((handler) => handler({ sessionIDs })),
        Effect.flatMap(Schema.decodeUnknownEffect(Open)),
        Effect.map((result) => result.questions),
        Effect.orDie,
      )
    const reply = (name: "answer" | "dismiss", input: unknown) =>
      method(name).pipe(Effect.flatMap((handler) => handler(input)), Effect.flatMap(Schema.decodeUnknownEffect(Reply)), Effect.orDie)
    const deleteSession = (sessionID: string) => Queue.offer(deletions, { type: "session.deleted", data: { sessionID } })
    const inbox = (sessionID: string) => (sessions.inboxes.get(sessionID) ?? []).map((message) => message.letter)
    /** The host's form submitted in `sessionID` with `answer`. */
    const submit = (sessionID: string, answer: Record<string, unknown>) =>
      Queue.offer(replies, { type: "form.replied", data: { id: `frm_${sessionID}`, sessionID, answer } })
    /** Wait until `sessionID` holds `count` messages. */
    const received = (sessionID: string, count: number) =>
      Effect.suspend(() => (inbox(sessionID).length < count ? Effect.fail("not yet") : Effect.void)).pipe(
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        Effect.orDie,
      )
    return { tool, call, fail, open, reply, deleteSession, inbox, emitted, submit, received }
  })

const port = { question: "Which port should the dev server use?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }

describe("the ask_user_async tool", () => {
  test("is a direct tool that says it returns at once", () =>
    scenario(
      Effect.gen(function* () {
        const { tool } = yield* start()
        expect(tool.name).toBe("ask_user_async")
        expect(tool.options).toEqual({ codemode: false })
        expect(tool.description).toContain("Returns immediately")
      }),
    ))

  test("returns the ids and assumptions at once, and the RPC lists the question", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.call({ questions: [port] })).toBe(
          [
            "Asked in the background; nobody has answered yet:",
            "- q1: Which port should the dev server use? · assuming 8080",
            "Continue on your assumption now. An answer arrives as a message in this session if the user gives one; if it differs from your assumption, revise the work that rests on it.",
          ].join("\n"),
        )
        const open = yield* plugin.open("ses_root")
        expect(open.map((question) => [question.id, question.sessionID, question.header])).toEqual([["q1", "ses_root", "Port"]])
        expect(plugin.emitted).toEqual([["changed", { sessionID: "ses_root" }]])
      }),
    ))

  test("a refused call is a tool error that says why and asks nothing", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.fail({ questions: [{ question: "Port?", assume: " " }] })).toBe(
          "Question 1: assume is empty: say what you do until an answer arrives. Nothing was asked.",
        )
        expect(yield* plugin.fail({ withdraw: ["q4"] })).toBe("No open question q4 to withdraw. Open: none. Nothing was asked.")
        expect(yield* plugin.open("ses_root")).toEqual([])
      }),
    ))
})

describe("answering", () => {
  test("an answer reaches the session that asked, once, and the question leaves the list", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ questions: [port] })
        expect(yield* plugin.reply("answer", { sessionID: "ses_root", answers: [{ id: "q1", answer: "3000" }] })).toEqual({ ok: true })
        const [letter, ...more] = plugin.inbox("ses_root")
        expect(more).toEqual([])
        expect(letter?.text).toContain("You assumed: 8080\nA: 3000\nThis differs from your assumption")
        expect(letter?.description).toBe("answered · Which port should the dev server use? → 3000")
        expect(yield* plugin.open("ses_root")).toEqual([])
        expect(yield* plugin.reply("answer", { sessionID: "ses_root", answers: [{ id: "q1", answer: "3000" }] })).toEqual({
          ok: false,
          message: "Question q1 is not open.",
        })
      }),
    ))

  test("the form's submit sends every answer given as one message; a blank one stays open, another form's reply is ignored", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ questions: [port, { question: "Keep the --legacy flag?", assume: "yes" }] })
        yield* plugin.call({ questions: [{ question: "Which test runner?", assume: "bun test" }, { question: "Fourth?", assume: "no" }] })
        yield* plugin.submit("ses_root", { q0: "a built-in question's answer" })
        yield* plugin.submit("ses_root", {
          "ask_user_async:q1": "3000",
          "ask_user_async:q2": "yes",
          "ask_user_async:q3": "vitest",
          "ask_user_async:q4": "",
        })
        yield* plugin.received("ses_root", 1)
        const [letter, ...more] = plugin.inbox("ses_root")
        expect(more).toEqual([])
        expect(letter?.text.split("\n")[0]).toBe("Answers to your background questions q1, q2 and q3:")
        expect(letter?.text.split("\n").at(-1)).toBe("Revise the work that rests on q1 and q3, and say what you changed; the rest are what you assumed.")
        expect((yield* plugin.open("ses_root")).map((question) => question.id)).toEqual(["q4"])
      }),
    ))

  test("two sessions' forms are two messages, each in the session that asked; a subagent's question shows with its parent's", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ questions: [port] })
        yield* plugin.call({ questions: [{ question: "Scan vendored code too?", assume: "no" }] }, "ses_child")
        const open = yield* plugin.open("ses_root", "ses_child")
        expect(open.map((question) => [question.sessionID, question.id])).toEqual([
          ["ses_root", "q1"],
          ["ses_child", "q1"],
        ])
        yield* plugin.submit("ses_child", { "ask_user_async:q1": "yes" })
        yield* plugin.submit("ses_root", { "ask_user_async:q1": "8080" })
        yield* plugin.received("ses_root", 1)
        yield* plugin.received("ses_child", 1)
        expect(plugin.inbox("ses_child").map((letter) => letter.description)).toEqual(["answered · Scan vendored code too? → yes"])
        expect(plugin.inbox("ses_root").map((letter) => letter.description)).toEqual(["answered · Which port should the dev server use? → 8080"])
      }),
    ))

  test("the form's dismiss (ctrl+x) alone closes the question and sends nothing; the assumed choice with a note sends the note on it", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ questions: [port, { question: "Keep the --legacy flag?", assume: "yes" }] })
        yield* plugin.submit("ses_root", { "ask_user_async:q1": "ask_user_async:dismiss", "ask_user_async:q2": "" })
        yield* Effect.suspend(() => plugin.open("ses_root")).pipe(
          Effect.flatMap((open) => (open.length === 1 ? Effect.void : Effect.fail("not yet"))),
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
          Effect.orDie,
        )
        expect((yield* plugin.open("ses_root")).map((question) => question.id)).toEqual(["q2"])
        expect(plugin.inbox("ses_root")).toEqual([])
        yield* plugin.submit("ses_root", { "ask_user_async:q2": "yes (note: drop it next release)" })
        yield* plugin.received("ses_root", 1)
        expect(plugin.inbox("ses_root").map((letter) => letter.text.split("\n").slice(-2))).toEqual([
          ["A: yes (note: drop it next release)", "This is what you assumed: carry on."],
        ])
        expect(yield* plugin.open("ses_root")).toEqual([])
      }),
    ))

  test("dismiss drops the question and the agent is told nothing", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ questions: [port] })
        expect(yield* plugin.reply("dismiss", { sessionID: "ses_root", id: "q1" })).toEqual({ ok: true })
        expect(yield* plugin.open("ses_root")).toEqual([])
        expect(plugin.inbox("ses_root")).toEqual([])
        expect(plugin.emitted.length).toBe(2)
      }),
    ))

  test("a malformed request is refused, not a failure", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const reply = yield* plugin.reply("answer", { sessionID: "ses_root" })
        expect(reply.ok).toBe(false)
        expect(reply.message).toStartWith("malformed request: ")
      }),
    ))

  test("a refused delivery keeps the answer, and the next start sends it once", () =>
    scenario(
      Effect.gen(function* () {
        const sheets = MemoryStore.empty()
        const sessions = MemoryCourier.empty("ses_root")
        const first = yield* start(sheets, sessions)
        yield* first.call({ questions: [port] })
        sessions.refusing.set("ses_root", "the session is reverting")
        expect(yield* first.reply("answer", { sessionID: "ses_root", answers: [{ id: "q1", answer: "3000" }] })).toEqual({
          ok: false,
          message: "The answer is saved and goes when the session takes it: the session is reverting",
        })
        sessions.refusing.delete("ses_root")
        const again = yield* start(sheets, sessions)
        // The resend runs in the background: wait for the message.
        yield* Effect.suspend(() => (again.inbox("ses_root").length === 0 ? Effect.fail("none yet") : Effect.void)).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        )
        expect(again.inbox("ses_root").map((letter) => letter.description)).toEqual(["answered · Which port should the dev server use? → 3000"])
        expect(sheets.sheets.get("ses_root")?.rows).toEqual([])
      }),
    ))

  test("a deleted session's questions go", () =>
    scenario(
      Effect.gen(function* () {
        const sheets = MemoryStore.empty()
        const plugin = yield* start(sheets)
        yield* plugin.call({ questions: [port] })
        yield* plugin.deleteSession("ses_root")
        yield* Effect.suspend(() => (sheets.sheets.has("ses_root") ? Effect.fail("present") : Effect.void)).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        )
        expect(sheets.sheets.has("ses_root")).toBe(false)
      }),
    ))
})

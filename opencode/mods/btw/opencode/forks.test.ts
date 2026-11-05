// Forks and ForkReadings over a stand-in for OpenCode's session client, its
// message list and the TUI's session status, all backed by the laws' World.
// The stand-in answers the way the host does: a fork names its source and is
// made after its copied history; a synthetic with no description is hidden; a
// synthetic whose id the session already holds is admitted once; a session
// the host does not hold rejects with the host's declared error (an Error
// named by its _tag); the message list pages newest first behind a cursor.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { forkReadingsLaws, forksLaws } from "../laws.ts"
import type { World } from "../memory/forks.ts"
import { answer, probe, world } from "../memory/forks.ts"
import { ForkReadings, Forks } from "../service.ts"
import * as OpencodeForks from "./forks.ts"
import * as OpencodeReadings from "./readings.ts"

const notFound = (sessionID: string) => Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "SessionNotFoundError" })

const sessionIn = (host: World, sessionID: string) => {
  const session = host.sessions.get(sessionID)
  return session === undefined ? Promise.reject(notFound(sessionID)) : Promise.resolve(session)
}

/** OpenCode's session client, as far as Forks calls it, over the World; `calls` records each request. */
const client = (host: World, calls: Array<[string, unknown]> = []): OpencodeForks.Sessions => ({
  fork: async (input) => {
    calls.push(["fork", input])
    const session = await sessionIn(host, input.sessionID)
    const id = `ses_fork${++host.forks}`
    const created = host.now++
    host.sessions.set(id, { title: session.title, createdAt: created, messages: [...session.messages], running: false })
    return { id, time: { created } }
  },
  update: async (input) => {
    calls.push(["update", input])
    const session = await sessionIn(host, input.sessionID)
    session.title = input.title
  },
  prompt: async (input) => {
    calls.push(["prompt", input])
    const session = await sessionIn(host, input.sessionID)
    session.messages.push({ type: "user", id: `msg_${session.messages.length}`, text: input.text, time: { created: host.now++ } })
    session.running = true
  },
  synthetic: async (input) => {
    calls.push(["synthetic", input])
    const session = await sessionIn(host, input.sessionID)
    if (input.id !== undefined && session.messages.some((message) => message.id === input.id)) return
    session.messages.push({ type: "synthetic", id: input.id ?? `msg_${session.messages.length}`, text: input.text, description: input.description, time: { created: host.now++ } })
    if (input.resume) session.running = true
  },
})

/** The message list and session status over the World; `pages` records each page asked for. */
const source = (host: World, pages: Array<string> = []): OpencodeReadings.Source => ({
  messages: async (input) => {
    pages.push(`${input.sessionID}@${input.cursor ?? "start"}`)
    const session = await sessionIn(host, input.sessionID)
    const newestFirst = session.messages.toReversed()
    const from = input.cursor === undefined ? 0 : Number(input.cursor)
    const to = from + input.limit
    return { data: newestFirst.slice(from, to), cursor: { next: to < newestFirst.length ? String(to) : null } }
  },
  status: (sessionID) => (host.sessions.get(sessionID)?.running === true ? "running" : "idle"),
})

const bench = (turns: number) => {
  const host = world({ main: turns })
  return { forks: OpencodeForks.layer(client(host)), readings: OpencodeReadings.layer(source(host)), host: probe(host) }
}

forksLaws("OpenCode's Forks", bench)
forkReadingsLaws("OpenCode's ForkReadings", bench)

describe("OpenCode's Forks", () => {
  test("asks with a hidden synthetic that does not wake the fork, then the prompt; brings back as a waking steer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const host = world({ main: 1 })
        const calls: Array<[string, unknown]> = []
        const forks = yield* Forks.pipe(Effect.provide(OpencodeForks.layer(client(host, calls))))
        yield* forks.ask("main", "the note", "why?")
        yield* forks.bringBack("main", { id: "msg_btw_1", text: "t", description: "btw · why?" })
        expect(calls).toEqual([
          ["synthetic", { sessionID: "main", text: "the note", resume: false }],
          ["prompt", { sessionID: "main", text: "why?" }],
          ["synthetic", { sessionID: "main", id: "msg_btw_1", text: "t", description: "btw · why?", delivery: "steer", resume: true }],
        ])
      }),
    ))

  test("a refusal carries the host's message, or its tag when the message is empty", () => {
    expect(OpencodeForks.messageOf(notFound("x"))).toBe("Session not found: x")
    expect(OpencodeForks.messageOf(Object.assign(new Error(""), { _tag: "ForkEmptyError" }))).toBe("ForkEmptyError")
    expect(OpencodeForks.messageOf({ data: { message: "nested" } })).toBe("nested")
    expect(OpencodeForks.messageOf("plain")).toBe("plain")
  })

  test("a failed ask stops before the prompt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const host = world({ main: 1 })
        const calls: Array<[string, unknown]> = []
        const refusing = { ...client(host, calls), synthetic: () => Promise.reject(new Error("refused")) }
        const failure = yield* Forks.use((forks) => Effect.flip(forks.ask("main", "note", "why?"))).pipe(Effect.provide(OpencodeForks.layer(refusing)))
        expect([failure.operation, failure.message]).toEqual(["ask", "refused"])
        expect(calls.map(([name]) => name)).toEqual([])
      }),
    ))
})

describe("OpenCode's ForkReadings", () => {
  test("reads the fork's own turns across pages, and stops at the first page that reaches the history it copied", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // 40 settled exchanges: 80 copied messages, then the fork's own.
        const host = world({ main: 40 })
        const pages: Array<string> = []
        const forks = yield* Forks.pipe(Effect.provide(OpencodeForks.layer(client(host))))
        const made = yield* forks.fork("main")
        const fork = { sessionID: made.sessionID, name: "btw", createdAt: made.createdAt, broughtBack: [] }
        for (let turn = 0; turn < 30; turn++) {
          yield* forks.ask(made.sessionID, "note", `q${turn}`)
          answer(host, made.sessionID, `a${turn}`)
        }
        const reading = yield* ForkReadings.use((readings) => readings.read(fork)).pipe(Effect.provide(OpencodeReadings.layer(source(host, pages))))
        expect(reading.turns.map((turn) => [turn.question, turn.answer])).toEqual(Array.from({ length: 30 }, (_, turn) => [`q${turn}`, `a${turn}`]))
        // 90 own messages and 80 copied: the second page of 50 reaches the copy, so a third is never asked for.
        expect(pages).toEqual([`${made.sessionID}@start`, `${made.sessionID}@50`])
      }),
    ))

  test("a list the host refuses reads as no turns", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refusing: OpencodeReadings.Source = { messages: () => Promise.reject(new Error("offline")), status: () => "idle" }
        const reading = yield* ForkReadings.use((readings) => readings.read({ sessionID: "ses_x", name: "btw", createdAt: 0, broughtBack: [] })).pipe(
          Effect.provide(OpencodeReadings.layer(refusing)),
        )
        expect(reading).toEqual({ turns: [], replying: false })
      }),
    ))
})

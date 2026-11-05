// The OpenCode Courier over a stand-in host: an inbox per session that admits
// an id once, as the host's inbox reconciles by id, a create that returns the
// session already made under an id, and a `Session.NotFoundError` for a
// session it does not have.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { courierLaws, type Received } from "../laws.ts"
import { Courier } from "../service.ts"
import { layer, minter, type Host, type Synthetic } from "./courier.ts"

interface Session {
  readonly directory: string
  readonly parentID?: string
  readonly inbox: Array<Received>
  readonly prompts: Array<{ readonly id: string; readonly text: string }>
}

const missing = (sessionID: string) => ({ _tag: "Session.NotFoundError", sessionID })

const host = (sessions: Map<string, Session>, calls: Array<Synthetic>): Host => ({
  synthetic: (input) =>
    Effect.suspend(() => {
      calls.push(input)
      const session = sessions.get(input.sessionID)
      if (session === undefined) return Effect.fail(missing(input.sessionID))
      if (!session.inbox.some((message) => message.id === input.id))
        session.inbox.push({ id: input.id, letter: { text: input.text, description: input.description, metadata: input.metadata as Received["letter"]["metadata"] }, resume: input.resume })
      return Effect.void
    }),
  create: ({ id, directory }) => Effect.sync(() => void (sessions.has(id) || sessions.set(id, { directory, inbox: [], prompts: [] }))),
  prompt: ({ sessionID, id, text }) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionID)
      if (session === undefined) return Effect.fail(missing(sessionID))
      if (!session.prompts.some((prompt) => prompt.id === id)) session.prompts.push({ id, text })
      return Effect.void
    }),
  get: (sessionID) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionID)
      return session === undefined ? Effect.fail(missing(sessionID)) : Effect.succeed(session.parentID === undefined ? {} : { parentID: session.parentID })
    }),
})

courierLaws(
  "the OpenCode sessions",
  Effect.sync(() => {
    const sessions = new Map<string, Session>()
    return {
      layer: layer(host(sessions, [])),
      open: (sessionID, parentID) => Effect.sync(() => void sessions.set(sessionID, { directory: "/work/app", ...(parentID === undefined ? {} : { parentID }), inbox: [], prompts: [] })),
      received: (sessionID) => Effect.sync(() => sessions.get(sessionID)?.inbox ?? []),
      started: (sessionID) =>
        Effect.sync(() => {
          const session = sessions.get(sessionID)
          return session === undefined ? undefined : { directory: session.directory, prompts: session.prompts }
        }),
    }
  }),
)

describe("delivering through the host", () => {
  test("a wake goes as a steer that wakes the session; a notice as one that does not", async () => {
    const calls: Array<Synthetic> = []
    const courier = layer(host(new Map([["ses_a", { directory: "/", inbox: [], prompts: [] }]]), calls))
    const letter = { text: "A", description: "wake w1 · A", metadata: { source: "wake" } }
    await Effect.runPromise(
      Courier.use((service) => Effect.all([service.deliver("ses_a", "msg_1", letter, true), service.deliver("ses_a", "msg_2", letter, false)])).pipe(Effect.provide(courier)),
    )
    expect(calls.map((call) => [call.id, call.delivery, call.resume])).toEqual([
      ["msg_1", "steer", true],
      ["msg_2", "steer", false],
    ])
  })

  test("another failure of the host is refused with its message, not as gone", async () => {
    const failing = layer({ ...host(new Map(), []), synthetic: () => Effect.fail(new Error("inbox closed")) })
    const failure = await Effect.runPromise(
      Courier.use((service) => service.deliver("ses_a", "msg_1", { text: "", description: "", metadata: {} }, true)).pipe(Effect.flip, Effect.provide(failing)),
    )
    expect(failure.message).toBe("inbox closed")
    expect(failure.gone).toBe(false)
  })

  test("ids are the host's: a prefix, twelve hex digits of time and counter (inverted for sessions), fourteen base62 characters", () => {
    const mint = minter("msg_", false, () => 0x1234_5678, (bytes) => bytes.fill(61))
    const first = mint()
    expect(first).toBe(`msg_${(0x1234_5678n * 0x1000n + 1n).toString(16).padStart(12, "0").slice(-12)}${"z".repeat(14)}`)
    expect(mint() > first).toBe(true)
    let now = 1000
    const sessions = minter("ses_", true, () => now)
    const older = sessions()
    now += 1
    const newer = sessions()
    expect(older.length).toBe(4 + 26)
    expect(newer < older).toBe(true)
  })
})

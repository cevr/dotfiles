// The OpenCode Courier over a stand-in host: an inbox per session that admits
// an id once, as the host's inbox reconciles by id, a create that returns the
// session already made under an id, and a `Session.NotFoundError` for a
// session it does not have.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Mark, MARK_KEY } from "../latch.ts"
import { courierLaws, type Received } from "../laws.ts"
import { Courier } from "../service.ts"
import { type Created, layer, minter, type Host, type Synthetic } from "./courier.ts"

interface Session {
  readonly directory: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: string
  metadata?: Record<string, unknown>
  readonly inbox: Array<Received>
  readonly prompts: Array<{ readonly id: string; readonly text: string }>
}

/** A session as the host's create makes it: a child takes its parent's metadata unless it is given its own. */
const made = (sessions: Map<string, Session>, input: Created): Session => {
  const { id: _, metadata, ...rest } = input
  const inherited = metadata ?? (input.parentID === undefined ? undefined : sessions.get(input.parentID)?.metadata)
  return { ...rest, ...(inherited === undefined ? {} : { metadata: inherited }), inbox: [], prompts: [] }
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
  create: (input) => Effect.sync(() => void (sessions.has(input.id) || sessions.set(input.id, made(sessions, input)))),
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
      return session === undefined ? Effect.fail(missing(sessionID)) : Effect.succeed(session)
    }),
  update: ({ sessionID, metadata }) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionID)
      if (session === undefined) return Effect.fail(missing(sessionID))
      session.metadata = metadata
      return Effect.void
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
      inspect: (sessionID) =>
        Effect.sync(() => {
          const session = sessions.get(sessionID)
          return session === undefined
            ? undefined
            : {
                parentID: session.parentID,
                title: session.title,
                agent: session.agent,
                model: session.model,
                mark: session.metadata?.[MARK_KEY] as Mark | undefined,
                prompts: session.prompts.length,
              }
        }),
    }
  }),
)

describe("a latch's child through the host", () => {
  const mark: Mark = { hold: "sabbath", reason: "It is the Sabbath", opensAt: 2, at: 1 }

  test("keeps the parent's metadata beside its mark, and a mark keeps the child's other metadata", async () => {
    const sessions = new Map<string, Session>([["ses_root", { directory: "/", metadata: { owner: "cvr" }, inbox: [], prompts: [] }]])
    const courier = layer(host(sessions, []))
    await Effect.runPromise(
      Courier.use((service) =>
        Effect.gen(function* () {
          yield* service.child({ sessionID: "ses_child", parentID: "ses_root", directory: "/", title: "T", agent: "worker", mark })
          expect(sessions.get("ses_child")?.metadata).toEqual({ owner: "cvr", [MARK_KEY]: mark })
          yield* service.mark("ses_child", undefined)
          expect(sessions.get("ses_child")?.metadata).toEqual({ owner: "cvr" })
        }),
      ).pipe(Effect.provide(courier)),
    )
  })
})

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

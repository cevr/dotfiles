// The OpenCode Courier over a stand-in host: an inbox per session that admits
// an id once, as the host's inbox reconciles by id, and fails with the host's
// `Session.NotFoundError` for a session it does not have.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { courierLaws, type Received } from "../laws.ts"
import { Courier } from "../service.ts"
import { layer, minter, notFound, type Synthetic } from "./courier.ts"

const missing = (sessionID: string) => ({ _tag: "Session.NotFoundError", sessionID })

const host = (inboxes: Map<string, Array<Received>>, calls: Array<Synthetic>) => ({
  synthetic: (input: Synthetic) =>
    Effect.suspend(() => {
      calls.push(input)
      const inbox = inboxes.get(input.sessionID)
      if (inbox === undefined) return Effect.fail(missing(input.sessionID))
      if (!inbox.some((message) => message.id === input.id))
        inbox.push({ id: input.id, letter: { text: input.text, description: input.description, metadata: input.metadata as Received["letter"]["metadata"] } })
      return Effect.void
    }),
})

courierLaws(
  "the OpenCode sessions",
  Effect.sync(() => {
    const inboxes = new Map<string, Array<Received>>()
    return {
      layer: layer(host(inboxes, [])),
      open: (sessionID) => Effect.sync(() => void inboxes.set(sessionID, [])),
      received: (sessionID) => Effect.sync(() => inboxes.get(sessionID) ?? []),
    }
  }),
)

describe("delivering through the host", () => {
  test("an answer goes as a steer that wakes the session", async () => {
    const calls: Array<Synthetic> = []
    const courier = layer(host(new Map([["ses_a", []]]), calls), () => "msg_1")
    await Effect.runPromise(
      Courier.use((service) => service.deliver("ses_a", "msg_1", { text: "A", description: "answered · Q → A", metadata: { source: "questions", answers: [] } })).pipe(
        Effect.provide(courier),
      ),
    )
    expect(calls).toEqual([
      { sessionID: "ses_a", id: "msg_1", text: "A", description: "answered · Q → A", metadata: { source: "questions", answers: [] }, delivery: "steer", resume: true },
    ])
  })

  test("a notice goes as a steer that does not wake the session", async () => {
    const calls: Array<Synthetic> = []
    const courier = layer(host(new Map([["ses_root", []]]), calls), () => "msg_2")
    await Effect.runPromise(
      Courier.use((service) => service.notify("ses_root", "msg_2", { text: "N", description: "x's question q1 answered · Q → A", metadata: { source: "questions", answers: [] } })).pipe(
        Effect.provide(courier),
      ),
    )
    expect(calls.map((call) => [call.sessionID, call.id, call.delivery, call.resume])).toEqual([["ses_root", "msg_2", "steer", false]])
  })

  test("another failure of the host is refused with its message", async () => {
    const failing = layer({ synthetic: () => Effect.fail(new Error("inbox closed")) })
    const failure = await Effect.runPromise(
      Courier.use((service) => service.deliver("ses_a", "msg_1", { text: "", description: "", metadata: { source: "questions", answers: [] } })).pipe(
        Effect.flip,
        Effect.provide(failing),
      ),
    )
    expect(failure.message).toBe("inbox closed")
    expect(failure.gone).toBe(false)
    expect(notFound(new Error("Session.NotFoundError"))).toBe(false)
  })

  test("ids are the host's: msg_, twelve hex digits of time and counter, fourteen base62 characters", () => {
    const mint = minter(() => 0x1234_5678, (bytes) => bytes.fill(61))
    const first = mint()
    const second = mint()
    expect(first).toBe(`msg_${(0x1234_5678n * 0x1000n + 1n).toString(16).padStart(12, "0").slice(-12)}${"z".repeat(14)}`)
    expect(first.length).toBe(4 + 26)
    expect(second > first).toBe(true)
  })
})

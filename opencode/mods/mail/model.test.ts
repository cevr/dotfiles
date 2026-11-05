// Mail's handlers over a test Sessions declared here: addressing by id and by
// title, the refusals, the reply-to, delivery and its log.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Option, References } from "effect"
import type { SessionCard } from "./directory.ts"
import type { Letter } from "./letter.ts"
import { layer, Mail } from "./model.ts"
import { DeliveryRefused, Sessions, SessionsUnreadable } from "./service.ts"

const NOW = 1_000_000

const card = (id: string, fields: Partial<SessionCard> = {}): SessionCard => ({ id, directory: "/work", running: false, updated: NOW, ...fields })

const CARDS: ReadonlyArray<SessionCard> = [
  card("ses_a", { title: "Bite PR", running: true, agent: "build" }),
  card("ses_b", { title: "Dotfiles", updated: NOW - 60_000 }),
  card("ses_c", { title: "Dotfiles review", updated: NOW - 120_000 }),
  card("ses_w", { title: "Fix money", parentID: "ses_a", running: true, updated: NOW - 1_000 }),
]

interface Sent {
  readonly sessionID: string
  readonly letter: Letter
  readonly wake: boolean
}

/** A test Sessions over `cards`; `unreadable` fails every read, `refuse` the inbox. */
const world = (options: { readonly unreadable?: boolean; readonly refuse?: boolean } = {}) => {
  const sent: Array<Sent> = []
  const logs: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = []
  const read = <A>(value: A) => (options.unreadable ? Effect.fail(new SessionsUnreadable({ message: "database is locked" })) : Effect.succeed(value))
  const sessions = Layer.succeed(
    Sessions,
    Sessions.of({
      get: (sessionID) => read(Option.fromNullishOr(CARDS.find((item) => item.id === sessionID))),
      list: ({ children }) => read(CARDS.filter((item) => children || item.parentID === undefined)),
      deliver: (sessionID, letter, wake) =>
        options.refuse ? Effect.fail(new DeliveryRefused({ sessionID, message: "inbox closed" })) : Effect.sync(() => void sent.push({ sessionID, letter, wake })),
    }),
  )
  const logger = Logger.make((entry) => {
    logs.push({ message: String(Array.isArray(entry.message) ? entry.message.join(" ") : entry.message), annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const run = <A, E>(body: (mail: Mail["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* Mail)
      }).pipe(Effect.provide(layer.pipe(Layer.provide(sessions))), Effect.provide(Logger.layer([logger])), Effect.result),
    )
  return { sent, logs, run }
}

describe("sending a message", () => {
  test("to an idle session by id wakes it with a letter from the sender, and logs the delivery", async () => {
    const { sent, logs, run } = world()
    const result = await run((mail) => mail.send("ses_a", { to: "ses_b", text: "rebase please" }))
    expect(result).toMatchObject({ _tag: "Success", success: { to: { id: "ses_b" }, delivery: "woke" } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionID: "ses_b", wake: true, letter: { description: "✉ from Bite PR · rebase please" } })
    expect(sent[0]?.letter.text).toStartWith('✉ Message from session "Bite PR" (ses_a)')
    expect(sent[0]?.letter.text).toEndWith("\n\nrebase please")
    expect(logs).toEqual([
      {
        message: "mail: Bite PR → Dotfiles",
        annotations: { from: "ses_a", to: "ses_b", replyTo: "ses_a", delivery: "woke", excerpt: "rebase please" },
      },
    ])
  })

  test("to a running session by title is a steer; wake: false on an idle one leaves it queued", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_b", { to: "bite pr", text: "done" }))).toMatchObject({
      _tag: "Success",
      success: { to: { id: "ses_a" }, delivery: "steered" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "review", text: "later", wake: false }))).toMatchObject({
      _tag: "Success",
      success: { to: { id: "ses_c" }, delivery: "queued" },
    })
    expect(sent.map((item) => [item.sessionID, item.wake])).toEqual([
      ["ses_a", true],
      ["ses_c", false],
    ])
  })

  test("a title reaches a subagent's session too, and its parent can write to it", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "Fix money", text: "stop" }))).toMatchObject({ _tag: "Success", success: { delivery: "steered" } })
    expect(sent[0]?.sessionID).toBe("ses_w")
  })

  test("names another session to answer when given replyTo, by id or title", async () => {
    const { sent, run } = world()
    await run((mail) => mail.send("ses_w", { to: "ses_b", text: "q", replyTo: "Bite PR" }))
    expect(sent[0]?.letter.metadata.replyTo).toEqual({ sessionID: "ses_a", title: "Bite PR" })
    expect(sent[0]?.letter.metadata.from).toEqual({ sessionID: "ses_w", title: "Fix money" })
  })

  test("refuses its own session, by id or by title, and delivers nothing", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "ses_a", text: "hi" }))).toMatchObject({ _tag: "Failure", failure: { _tag: "SelfAddressed" } })
    expect(await run((mail) => mail.send("ses_a", { to: "Bite PR", text: "hi" }))).toMatchObject({ _tag: "Failure", failure: { _tag: "SelfAddressed" } })
    expect(sent).toEqual([])
  })

  test("refuses a session that does not exist, an ambiguous title, a missing reply-to and an empty text", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "ses_zzz", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoSuchSession", to: "ses_zzz" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "dotfiles r", text: "hi" }))).toMatchObject({ _tag: "Success" })
    expect(await run((mail) => mail.send("ses_a", { to: "otfiles", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AmbiguousTitle", matches: [{ id: "ses_b" }, { id: "ses_c" }] },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi", replyTo: "nobody" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoSuchSession", to: "nobody" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "ses_b", text: " \n " }))).toMatchObject({ _tag: "Failure", failure: { _tag: "EmptyMessage" } })
    expect(sent.map((item) => item.sessionID)).toEqual(["ses_c"])
  })

  test("an exact title wins over a longer one that contains it", async () => {
    const { sent, run } = world()
    await run((mail) => mail.send("ses_a", { to: "dotfiles", text: "hi" }))
    expect(sent[0]?.sessionID).toBe("ses_b")
  })

  test("logs no more than 200 characters of the text", async () => {
    const { logs, run } = world()
    await run((mail) => mail.send("ses_a", { to: "ses_b", text: "y".repeat(500) }))
    expect(logs[0]?.annotations.excerpt).toBe(`${"y".repeat(199)}…`)
  })

  test("passes on an unreadable server and a refused delivery", async () => {
    expect(await world({ unreadable: true }).run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionsUnreadable" },
    })
    expect(await world({ refuse: true }).run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DeliveryRefused", sessionID: "ses_b" },
    })
  })
})

describe("listing the sessions", () => {
  test("gives the main sessions by default and the subagents' on request, marking the caller", async () => {
    const { run } = world()
    const main = await run((mail) => mail.sessions("ses_b", {}))
    expect(main).toMatchObject({ _tag: "Success" })
    const text = main._tag === "Success" ? main.success : ""
    expect(text.split("\n")[0]).toBe("Sessions (3):")
    expect(text).toContain('ses_b "Dotfiles" · idle · /work')
    expect(text).toContain("(you)")
    expect(text).not.toContain("ses_w")
    const all = await run((mail) => mail.sessions("ses_b", { children: true, search: "money" }))
    expect(all._tag === "Success" ? all.success : "").toMatch(/^Sessions \(1\):\nses_w "Fix money" · running · \/work · .+ · child of ses_a$/)
  })
})

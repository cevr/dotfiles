// The questions model over the memory doubles: what the server does with a
// question from ask to delivery, without OpenCode.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as MemoryCourier from "./courier.ts"
import * as MemoryStore from "./store.ts"
import * as Model from "../model.ts"
import { QuestionsModel } from "../model.ts"
import { Changes } from "../service.ts"

const rig = (...sessionIDs: ReadonlyArray<string>) => {
  const sheets = MemoryStore.empty()
  const sessions = MemoryCourier.empty(...sessionIDs)
  const changed: Array<string> = []
  const layer = Model.layer.pipe(
    Layer.provide(MemoryStore.layer(sheets)),
    Layer.provide(MemoryCourier.layer(sessions)),
    Layer.provide(Layer.succeed(Changes, { changed: (sessionID) => Effect.sync(() => void changed.push(sessionID)) })),
  )
  const run = <A, E>(body: (model: QuestionsModel["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(QuestionsModel.use(body).pipe(Effect.provide(layer)))
  const fail = <A, E>(body: (model: QuestionsModel["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(QuestionsModel.use(body).pipe(Effect.flip, Effect.provide(layer)))
  const texts = (sessionID: string) => (sessions.inboxes.get(sessionID) ?? []).map((message) => message.letter.text)
  return { sheets, sessions, changed, run, fail, texts }
}

const port = { question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }

describe("QuestionsModel", () => {
  test("asking stores the question, announces the change and returns what opened", async () => {
    const { run, changed } = rig("ses_a")
    const asked = await run((model) => model.ask("ses_a", { questions: [port] }))
    expect(asked.opened.map((question) => [question.id, question.sessionID, question.assume])).toEqual([["q1", "ses_a", "8080"]])
    expect(asked.closed).toEqual([])
    expect(changed).toEqual(["ses_a"])
    expect((await run((model) => model.open(["ses_a"]))).map((question) => question.id)).toEqual(["q1"])
  })

  test("a refused call stores nothing and announces nothing", async () => {
    const { run, fail, changed } = rig("ses_a")
    expect((await fail((model) => model.ask("ses_a", { withdraw: ["q1"] })))._tag).toBe("UnknownQuestion")
    expect(changed).toEqual([])
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
  })

  test("an answer reaches the asking session once, and the question closes", async () => {
    const { run, fail, texts, sheets } = rig("ses_a")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.answer("ses_a", "q1", "3000"))
    expect(texts("ses_a")).toHaveLength(1)
    expect(texts("ses_a")[0]).toContain("A: 3000")
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
    expect(sheets.sheets.get("ses_a")?.rows).toEqual([])
    expect((await fail((model) => model.answer("ses_a", "q1", "8080")))._tag).toBe("NotOpen")
  })

  test("a refused delivery keeps the answer and sends it, under the same id, on the next read", async () => {
    const { run, fail, texts, sessions } = rig("ses_a")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    sessions.refusing.set("ses_a", "busy")
    expect((await fail((model) => model.answer("ses_a", "q1", "3000")))._tag).toBe("DeliveryRefused")
    expect(texts("ses_a")).toEqual([])
    // Answered, so no longer for the user to answer, even while it waits to be sent.
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
    sessions.refusing.delete("ses_a")
    await run((model) => model.open(["ses_a"]))
    expect(texts("ses_a")).toHaveLength(1)
    expect(sessions.inboxes.get("ses_a")?.[0]?.id).toBe("msg_000000000001")
  })

  test("resend sends what a restart left recorded and unsent, and counts it", async () => {
    const { run, fail, texts, sessions } = rig("ses_a", "ses_b")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.ask("ses_b", { questions: [port] }))
    sessions.refusing.set("ses_a", "down")
    sessions.refusing.set("ses_b", "down")
    await fail((model) => model.answer("ses_a", "q1", "3000"))
    await fail((model) => model.answer("ses_b", "q1", "8080"))
    sessions.refusing.delete("ses_a")
    expect(await run((model) => model.resend)).toBe(1)
    expect(texts("ses_a")).toHaveLength(1)
    sessions.refusing.delete("ses_b")
    expect(await run((model) => model.resend)).toBe(1)
    expect(await run((model) => model.resend)).toBe(0)
    expect(texts("ses_b")[0]).toContain("This is what you assumed: carry on.")
  })

  test("resend removes the sheet of a session that no longer exists", async () => {
    const { run, fail, sheets, sessions } = rig("ses_a")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    sessions.refusing.set("ses_a", "down")
    await fail((model) => model.answer("ses_a", "q1", "3000"))
    sessions.inboxes.delete("ses_a")
    expect(await run((model) => model.resend)).toBe(0)
    expect(sheets.sheets.has("ses_a")).toBe(false)
  })

  test("open lists several sessions' questions oldest first, and skips a sheet it cannot read", async () => {
    const { run, sheets } = rig("ses_a", "ses_b")
    await run((model) => model.ask("ses_b", { questions: [{ question: "First?", assume: "no" }] }))
    await Bun.sleep(2)
    await run((model) => model.ask("ses_a", { questions: [{ question: "Second?", assume: "no" }] }))
    sheets.broken.set("ses_c", "garbled")
    expect((await run((model) => model.open(["ses_a", "ses_b", "ses_c"]))).map((question) => question.question)).toEqual(["First?", "Second?"])
  })

  test("dismiss drops the question and tells the agent nothing", async () => {
    const { run, texts } = rig("ses_a")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.dismiss("ses_a", "q1"))
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
    expect(texts("ses_a")).toEqual([])
  })

  test("forget removes the session's sheet and announces it", async () => {
    const { run, sheets, changed } = rig("ses_a")
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.forget("ses_a"))
    expect(sheets.sheets.has("ses_a")).toBe(false)
    expect(changed).toEqual(["ses_a", "ses_a"])
  })
})

// The questions model over the memory doubles: what the server does with a
// question from ask to delivery, without OpenCode.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as MemoryCourier from "./courier.ts"
import * as MemoryStore from "./store.ts"
import * as Model from "../model.ts"
import { QuestionsModel } from "../model.ts"
import { AskFor, type Sheet } from "../question.ts"
import { Changes, Courier, QuestionStore } from "../service.ts"

/** The model over `sheets` and `sessions`, as one server would build it; `onDeliver` runs as a message goes. */
const rig = (sheets = MemoryStore.empty(), sessions = MemoryCourier.empty("ses_a"), onDeliver: (sessionID: string) => void = () => {}) => {
  const changed: Array<string> = []
  const courier = Layer.effect(
    Courier,
    Effect.gen(function* () {
      const inner = yield* Courier
      return {
        newDelivery: inner.newDelivery,
        deliver: (sessionID: string, delivery: string, letter: Parameters<typeof inner.deliver>[2]) =>
          Effect.sync(() => onDeliver(sessionID)).pipe(Effect.andThen(inner.deliver(sessionID, delivery, letter))),
        notify: inner.notify,
      }
    }),
  ).pipe(Layer.provide(MemoryCourier.layer(sessions)))
  const layer = Model.layer.pipe(
    Layer.provide(MemoryStore.layer(sheets)),
    Layer.provide(courier),
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
const flag = { question: "Keep the --legacy flag?", assume: "yes" }
const runner = { question: "Which test runner?", assume: "bun test" }

describe("QuestionsModel", () => {
  test("asking stores the question, announces the change and returns what opened", async () => {
    const { run, changed } = rig()
    const asked = await run((model) => model.ask("ses_a", { questions: [port] }))
    expect(asked.opened.map((question) => [question.id, question.sessionID, question.assume])).toEqual([["q1", "ses_a", "8080"]])
    expect(asked.closed).toEqual([])
    expect(changed).toEqual(["ses_a"])
    expect((await run((model) => model.open(["ses_a"]))).map((question) => question.id)).toEqual(["q1"])
  })

  test("a refused call stores nothing and announces nothing", async () => {
    const { run, fail, changed } = rig()
    expect((await fail((model) => model.ask("ses_a", { withdraw: ["q1"] })))._tag).toBe("UnknownQuestion")
    expect(changed).toEqual([])
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
  })

  test("one answer reaches the asking session once, in the one-answer letter, and the question closes", async () => {
    const { run, fail, texts, sheets } = rig()
    await run((model) => model.ask("ses_a", { questions: [port] }))
    expect(await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }]))).toEqual({ answered: ["q1"], dismissed: [], skipped: [] })
    expect(texts("ses_a")).toHaveLength(1)
    expect(texts("ses_a")[0]).toStartWith("Answer to your background question q1 (asked ")
    expect(texts("ses_a")[0]).toContain("A: 3000")
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
    expect(sheets.sheets.get("ses_a")?.rows).toEqual([])
    expect((await fail((model) => model.answer("ses_a", [{ id: "q1", answer: "8080" }])))._tag).toBe("NotOpen")
  })

  test("three answered in one submit, from two asks, reach the session as one message; the blank one stays open", async () => {
    const { run, texts, sessions } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.ask("ses_a", { questions: [runner, { question: "Fourth?", assume: "no" }] }))
    const done = await run((model) =>
      model.answer("ses_a", [
        { id: "q1", answer: "3000" },
        { id: "q2", answer: "yes" },
        { id: "q3", answer: "vitest" },
      ]),
    )
    expect(done).toEqual({ answered: ["q1", "q2", "q3"], dismissed: [], skipped: [] })
    expect(texts("ses_a")).toHaveLength(1)
    expect(texts("ses_a")[0]).toStartWith("Answers to your background questions q1, q2 and q3:")
    expect(sessions.inboxes.get("ses_a")?.[0]?.letter.metadata.answers.map((answer) => answer.id)).toEqual(["q1", "q2", "q3"])
    expect((await run((model) => model.open(["ses_a"]))).map((question) => question.id)).toEqual(["q4"])
  })

  test("a later submit is a message of its own", async () => {
    const { run, texts } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }]))
    await run((model) => model.answer("ses_a", [{ id: "q2", answer: "no" }]))
    expect(texts("ses_a").map((text) => text.split("\n")[0])).toEqual([
      expect.stringContaining("Answer to your background question q1"),
      expect.stringContaining("Answer to your background question q2"),
    ])
  })

  test("two sessions' answers are two messages, one in each", async () => {
    const { run, texts } = rig(MemoryStore.empty(), MemoryCourier.empty("ses_a", "ses_b"))
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.ask("ses_b", { questions: [runner] }))
    await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "no" }]))
    await run((model) => model.answer("ses_b", [{ id: "q1", answer: "vitest" }]))
    expect(texts("ses_a")).toHaveLength(1)
    expect(texts("ses_a")[0]).toContain("q1 and q2")
    expect(texts("ses_b")).toHaveLength(1)
    expect(texts("ses_b")[0]).toContain("A: vitest")
  })

  test("a submit answers what is still open and names what was not", async () => {
    const { run, texts } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.ask("ses_a", { withdraw: ["q2"] }))
    expect(await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "no" }]))).toEqual({ answered: ["q1"], dismissed: [], skipped: ["q2"] })
    expect(texts("ses_a")).toHaveLength(1)
  })

  test("reading the open questions sends nothing; a refused submit goes, as one message under its id, with the session's next answer", async () => {
    const { run, fail, texts, sessions } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag, runner] }))
    sessions.refusing.set("ses_a", "busy")
    expect((await fail((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "no" }])))._tag).toBe("DeliveryRefused")
    // Answered, so no longer for the user to answer, even while it waits to be sent.
    expect((await run((model) => model.open(["ses_a"]))).map((question) => question.id)).toEqual(["q3"])
    sessions.refusing.delete("ses_a")
    await run((model) => model.open(["ses_a"]))
    expect(texts("ses_a")).toEqual([])
    await run((model) => model.answer("ses_a", [{ id: "q3", answer: "vitest" }]))
    // The older submit first, as it was given; then the new one.
    expect(sessions.inboxes.get("ses_a")?.map((message) => [message.id, message.letter.metadata.answers.map((answer) => answer.id)])).toEqual([
      ["msg_000000000001", ["q1", "q2"]],
      ["msg_000000000002", ["q3"]],
    ])
  })

  test("a restart between saving and sending delivers the submit once", async () => {
    const sheets = MemoryStore.empty()
    const sessions = MemoryCourier.empty("ses_a")
    const first = rig(sheets, sessions)
    await first.run((model) => model.ask("ses_a", { questions: [port, flag] }))
    // The server stops after the answers are saved and before they go.
    sessions.refusing.set("ses_a", "the server stopped")
    await first.fail((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "no" }]))
    sessions.refusing.delete("ses_a")
    const second = rig(sheets, sessions)
    expect(await second.run((model) => model.resend)).toBe(1)
    expect(await second.run((model) => model.resend)).toBe(0)
    expect(second.texts("ses_a")).toHaveLength(1)
    expect(second.texts("ses_a")[0]).toContain("q1 and q2")
  })

  test("a restart after sending and before closing sends the same message again, and the session holds it once", async () => {
    const sheets = MemoryStore.empty()
    const sessions = MemoryCourier.empty("ses_a")
    let saved: Sheet | undefined
    const first = rig(sheets, sessions, (sessionID) => void (saved = sheets.sheets.get(sessionID)))
    await first.run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await first.run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "no" }]))
    // The server stopped after the message went and before the questions closed: the sheet still holds the batch.
    if (saved === undefined) throw new Error("nothing was delivered")
    sheets.sheets.set("ses_a", saved)
    const second = rig(sheets, sessions)
    expect(await second.run((model) => model.resend)).toBe(1)
    expect(second.texts("ses_a")).toHaveLength(1)
    expect(sheets.sheets.get("ses_a")?.rows).toEqual([])
  })

  test("resend sends what a restart left recorded and unsent, and counts it", async () => {
    const { run, fail, texts, sessions } = rig(MemoryStore.empty(), MemoryCourier.empty("ses_a", "ses_b"))
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.ask("ses_b", { questions: [port] }))
    sessions.refusing.set("ses_a", "down")
    sessions.refusing.set("ses_b", "down")
    await fail((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }]))
    await fail((model) => model.answer("ses_b", [{ id: "q1", answer: "8080" }]))
    sessions.refusing.delete("ses_a")
    expect(await run((model) => model.resend)).toBe(1)
    expect(texts("ses_a")).toHaveLength(1)
    sessions.refusing.delete("ses_b")
    expect(await run((model) => model.resend)).toBe(1)
    expect(await run((model) => model.resend)).toBe(0)
    expect(texts("ses_b")[0]).toContain("This is what you assumed: carry on.")
  })

  test("resend removes the sheet of a session that no longer exists", async () => {
    const { run, fail, sheets, sessions } = rig()
    await run((model) => model.ask("ses_a", { questions: [port] }))
    sessions.refusing.set("ses_a", "down")
    await fail((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }]))
    sessions.inboxes.delete("ses_a")
    expect(await run((model) => model.resend)).toBe(0)
    expect(sheets.sheets.has("ses_a")).toBe(false)
  })

  test("open lists several sessions' questions oldest first, and skips a sheet it cannot read", async () => {
    const { run, sheets } = rig(MemoryStore.empty(), MemoryCourier.empty("ses_a", "ses_b"))
    await run((model) => model.ask("ses_b", { questions: [{ question: "First?", assume: "no" }] }))
    await Bun.sleep(2)
    await run((model) => model.ask("ses_a", { questions: [{ question: "Second?", assume: "no" }] }))
    sheets.broken.set("ses_c", "garbled")
    expect((await run((model) => model.open(["ses_a", "ses_b", "ses_c"]))).map((question) => question.question)).toEqual(["First?", "Second?"])
  })

  test("dismiss drops the question and tells the agent nothing", async () => {
    const { run, texts } = rig()
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.dismiss("ses_a", "q1"))
    expect(await run((model) => model.open(["ses_a"]))).toEqual([])
    expect(texts("ses_a")).toEqual([])
  })

  test("a submit that only dismisses closes its questions and sends nothing, then or later", async () => {
    const { run, texts, sheets } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    expect(await run((model) => model.answer("ses_a", [], ["q1"]))).toEqual({ answered: [], dismissed: ["q1"], skipped: [] })
    expect((await run((model) => model.open(["ses_a"]))).map((question) => question.id)).toEqual(["q2"])
    expect(sheets.sheets.get("ses_a")?.rows.map((row) => row.id)).toEqual(["q2"])
    expect(await run((model) => model.resend)).toBe(0)
    expect(texts("ses_a")).toEqual([])
  })

  test("a submit that answers and dismisses sends one message naming the dismissed; a resend sends nothing more", async () => {
    const { run, texts, sheets } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag, runner] }))
    expect(await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }], ["q3"]))).toEqual({ answered: ["q1"], dismissed: ["q3"], skipped: [] })
    expect(texts("ses_a")).toHaveLength(1)
    expect(texts("ses_a")[0]).toStartWith("Answer to your background question q1 (asked ")
    expect(texts("ses_a")[0]).toEndWith("q3 dismissed: your assumption stands (Which test runner? You assumed: bun test)")
    expect(sheets.sheets.get("ses_a")?.rows.map((row) => row.id)).toEqual(["q2"])
    expect(await run((model) => model.resend)).toBe(0)
    expect(texts("ses_a")).toHaveLength(1)
  })

  describe("a subagent's questions", () => {
    /** An orchestrator, the implementor it started, and a worker the implementor started. */
    const tree = () => {
      const sessions = MemoryCourier.empty("ses_root")
      MemoryCourier.child(sessions, { id: "ses_impl", parentID: "ses_root", title: "implementor auth r1", agent: "implementor" })
      MemoryCourier.child(sessions, { id: "ses_worker", parentID: "ses_impl", title: "Port scan", agent: "worker" })
      return rig(MemoryStore.empty(), sessions)
    }
    const notices = (sessions: MemoryCourier.MemorySessions, sessionID: string) =>
      (sessions.inboxes.get(sessionID) ?? []).filter((message) => sessions.quiet.has(message.id)).map((message) => message.letter)

    test("an answer goes to the subagent that asked and wakes it; the root of its tree gets a notice naming it, without being woken", async () => {
      const { run, texts, sessions } = tree()
      await run((model) => model.ask("ses_impl", { questions: [port] }))
      await run((model) => model.answer("ses_impl", [{ id: "q1", answer: "3000" }]))
      expect(texts("ses_impl")).toEqual([expect.stringMatching(/^Answer to your background question q1 \(asked /)])
      expect(notices(sessions, "ses_impl")).toEqual([])
      const [notice, ...more] = notices(sessions, "ses_root")
      expect(more).toEqual([])
      expect(texts("ses_root")).toHaveLength(1)
      expect(notice?.text).toStartWith("The subagent implementor auth r1 had its background question q1 answered; the answer went to it:")
      expect(notice?.description).toBe("implementor auth r1's question q1 answered · Which port? → 3000")
      expect(notice?.metadata.notice).toEqual({ sessionID: "ses_impl", asker: "implementor auth r1" })
    })

    test("a subagent of a subagent: the notice goes to the root, not to the parent between", async () => {
      const { run, texts, sessions } = tree()
      await run((model) => model.ask("ses_worker", { questions: [runner] }))
      await run((model) => model.answer("ses_worker", [{ id: "q1", answer: "vitest" }]))
      expect(texts("ses_worker")).toHaveLength(1)
      expect(texts("ses_impl")).toEqual([])
      expect(notices(sessions, "ses_root").map((letter) => letter.description)).toEqual(["Port scan (worker)'s question q1 answered · Which test runner? → vitest"])
    })

    test("a root's own answer sends no notice, and a subagent's submit that only dismisses sends nothing anywhere", async () => {
      const { run, sessions } = tree()
      await run((model) => model.ask("ses_root", { questions: [flag] }))
      await run((model) => model.ask("ses_impl", { questions: [port] }))
      await run((model) => model.answer("ses_root", [{ id: "q1", answer: "no" }]))
      await run((model) => model.answer("ses_impl", [], ["q1"]))
      expect(notices(sessions, "ses_root")).toEqual([])
      expect(sessions.inboxes.get("ses_root")).toHaveLength(1)
      expect(sessions.inboxes.get("ses_impl")).toEqual([])
    })

    test("a withdraw leaves what the root's tray reads", async () => {
      const { run } = tree()
      await run((model) => model.ask("ses_impl", { questions: [port, flag] }))
      expect((await run((model) => model.open(["ses_root", "ses_impl", "ses_worker"]))).map((question) => [question.sessionID, question.id])).toEqual([
        ["ses_impl", "q1"],
        ["ses_impl", "q2"],
      ])
      await run((model) => model.ask("ses_impl", { withdraw: ["q1"] }))
      expect((await run((model) => model.open(["ses_root", "ses_impl", "ses_worker"]))).map((question) => question.id)).toEqual(["q2"])
    })

    test("a root that is gone loses the notice, not the answer", async () => {
      const { run, texts, sessions } = tree()
      await run((model) => model.ask("ses_impl", { questions: [port] }))
      sessions.inboxes.delete("ses_root")
      expect(await run((model) => model.answer("ses_impl", [{ id: "q1", answer: "3000" }]))).toEqual({ answered: ["q1"], dismissed: [], skipped: [] })
      expect(texts("ses_impl")).toHaveLength(1)
      expect(await run((model) => model.open(["ses_impl"]))).toEqual([])
    })

    test("a subagent's answer a restart left unsent goes with its notice at the next start", async () => {
      const { run, fail, texts, sessions } = tree()
      await run((model) => model.ask("ses_impl", { questions: [port] }))
      sessions.refusing.set("ses_impl", "down")
      await fail((model) => model.answer("ses_impl", [{ id: "q1", answer: "3000" }]))
      expect(notices(sessions, "ses_root")).toEqual([])
      sessions.refusing.delete("ses_impl")
      expect(await run((model) => model.resend)).toBe(1)
      expect(texts("ses_impl")).toHaveLength(1)
      expect(notices(sessions, "ses_root")).toHaveLength(1)
    })

    test("a subagent forgotten (deleted or ended) has no open question left at the root", async () => {
      const { run } = tree()
      await run((model) => model.ask("ses_impl", { questions: [port] }))
      await run((model) => model.forget("ses_impl"))
      expect(await run((model) => model.open(["ses_root", "ses_impl"]))).toEqual([])
    })
  })

  describe("a plugin's questions", () => {
    const reset = (key: string) =>
      AskFor.make({
        sessionID: "ses_a",
        from: { plugin: "dotfiles-opencode.pool", key },
        question: "Claude reset on account 4 now: … Claim it?",
        header: "Claude reset · 4",
        options: [{ label: "Claim it" }, { label: "Don't claim" }],
        assume: "Don't claim: the start waits for the window to reset",
      })

    test("asked once per key, shown in the tray beside the agent's; its answer is no message, and waits for the plugin until it withdraws it", async () => {
      const { run, texts, changed } = rig()
      await run((model) => model.ask("ses_a", { questions: [port] }))
      await run((model) => model.askFor(reset("hold-1")))
      await run((model) => model.askFor(reset("hold-1")))
      expect((await run((model) => model.open(["ses_a"]))).map((question) => [question.id, question.from?.key])).toEqual([
        ["q1", undefined],
        ["q2", "hold-1"],
      ])
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toEqual([{ sessionID: "ses_a", id: "q2", key: "hold-1" }])
      expect(await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "Claim it" }]))).toEqual({
        answered: ["q1", "q2"],
        dismissed: [],
        skipped: [],
      })
      expect(texts("ses_a")).toHaveLength(1)
      expect(texts("ses_a")[0]).not.toContain("Claim it")
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toEqual([{ sessionID: "ses_a", id: "q2", key: "hold-1", answer: "Claim it" }])
      expect(await run((model) => model.resend)).toBe(0)
      expect(await run((model) => model.askFor(reset("hold-1")))).toBeUndefined()
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toHaveLength(1)
      changed.length = 0
      await run((model) => model.withdrawFor({ plugin: "dotfiles-opencode.pool", key: "hold-1" }))
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toEqual([])
      expect(changed).toEqual(["ses_a"])
    })

    test("the agent cannot withdraw, replace or drop a plugin's question", async () => {
      const { run, fail } = rig()
      await run((model) => model.askFor(reset("hold-1")))
      expect((await fail((model) => model.ask("ses_a", { withdraw: ["q1"] })))._tag).toBe("UnknownQuestion")
      await run((model) => model.ask("ses_a", { questions: [{ question: "Claude reset on account 4 now: … Claim it?", assume: "no" }] }))
      for (let at = 0; at < 8; at++) await run((model) => model.ask("ses_a", { questions: [{ question: `Q${at}?`, assume: "no" }] }))
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toEqual([{ sessionID: "ses_a", id: "q1", key: "hold-1" }])
    })

    test("withdrawn while open, it leaves the tray; dismissed by the owner, it is gone from what the plugin reads", async () => {
      const { run } = rig()
      await run((model) => model.askFor(reset("hold-1")))
      await run((model) => model.withdrawFor({ plugin: "dotfiles-opencode.pool", key: "hold-1" }))
      expect(await run((model) => model.open(["ses_a"]))).toEqual([])
      await run((model) => model.askFor(reset("hold-2")))
      await run((model) => model.dismiss("ses_a", "q2"))
      expect(await run((model) => model.asked("dotfiles-opencode.pool"))).toEqual([])
    })
  })

  test("forget removes the session's sheet and announces it", async () => {
    const { run, sheets, changed } = rig()
    await run((model) => model.ask("ses_a", { questions: [port] }))
    await run((model) => model.forget("ses_a"))
    expect(sheets.sheets.has("ses_a")).toBe(false)
    expect(changed).toEqual(["ses_a", "ses_a"])
  })

  test("reading a large family's questions reads only the sheets of the sessions that asked", async () => {
    const { run, sheets } = rig()
    await run((model) => model.ask("ses_a", { questions: [port] }))
    const reads: Array<string> = []
    const counted = Layer.effect(
      QuestionStore,
      Effect.gen(function* () {
        const inner = yield* QuestionStore
        return {
          ...inner,
          read: (sessionID: string) => Effect.sync(() => void reads.push(sessionID)).pipe(Effect.andThen(inner.read(sessionID))),
        }
      }),
    ).pipe(Layer.provide(MemoryStore.layer(sheets)))
    const layer = Model.layer.pipe(
      Layer.provide(counted),
      Layer.provide(MemoryCourier.layer(MemoryCourier.empty("ses_a"))),
      Layer.provide(Layer.succeed(Changes, { changed: () => Effect.void })),
    )
    const family = ["ses_a", ...Array.from({ length: 500 }, (_, at) => `ses_child_${at}`)]
    const open = await Effect.runPromise(QuestionsModel.use((model) => model.open(family)).pipe(Effect.provide(layer)))
    expect(open.map((question) => question.id)).toEqual(["q1"])
    expect(reads).toEqual(["ses_a"])
  })
})

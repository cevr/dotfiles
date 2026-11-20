// The questions' digest lines, over the memory doubles: an owner's question writes one line as it opens, one as it is
// answered (saying whether the answer is what the agent assumed), one as it closes unanswered; a question put to an
// orchestrator writes none.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { byteLength, decodeLine, MAX_LINE } from "@dotfiles/opencode-digest/event"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import * as Model from "../model.ts"
import { QuestionsModel } from "../model.ts"
import { linesOf } from "../digest.ts"
import { QuestionClosed, type Row } from "../question.ts"
import { Changes } from "../service.ts"
import * as MemoryCourier from "./courier.ts"
import * as MemoryStore from "./store.ts"

const rig = () => {
  const digest = MemoryDigest.empty()
  const sessions = MemoryCourier.empty("ses_a")
  const layer = Model.layer.pipe(
    Layer.provide(MemoryDigest.writer(digest)),
    Layer.provide(MemoryStore.layer(MemoryStore.empty())),
    Layer.provide(MemoryCourier.layer(sessions)),
    Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
  )
  const run = <A, E>(body: (model: QuestionsModel["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(QuestionsModel.use(body).pipe(Effect.provide(layer)))
  const lines = () => {
    const all = Ref.getUnsafe(digest.lines)
    expect(all.every((line) => byteLength(line) <= MAX_LINE)).toBe(true)
    return all.flatMap((line) =>
        Option.toArray(
          Option.map(decodeLine(line), (event) => {
            if (event._tag === "Asked") return [event._tag, event.id, event.assume, event.options.join("|")]
            if (event._tag === "Answered") return [event._tag, event.id, event.answer, event.matches]
            if (event._tag === "Closed") return [event._tag, event.id, event.reason]
            return [event._tag]
          }),
        ),
      )
  }
  return { run, lines }
}

const port = { question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }
const flag = { question: "Keep the --legacy flag?", assume: "yes" }

describe("the questions' digest lines", () => {
  test("one line as an owner's question opens, and one as it is answered, saying whether it differs", async () => {
    const { run, lines } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.answer("ses_a", [{ id: "q1", answer: "3000" }, { id: "q2", answer: "yes" }]))
    expect(lines()).toEqual([
      ["Asked", "q1", "8080", "8080|3000"],
      ["Asked", "q2", "yes", ""],
      ["Answered", "q1", "3000", false],
      ["Answered", "q2", "yes", true],
    ])
  })

  test("a question withdrawn or dismissed unanswered closes in one line", async () => {
    const { run, lines } = rig()
    await run((model) => model.ask("ses_a", { questions: [port, flag] }))
    await run((model) => model.ask("ses_a", { withdraw: ["q1"] }))
    await run((model) => model.dismiss("ses_a", "q2"))
    expect(lines().slice(2)).toEqual([
      ["Closed", "q1", "withdrawn"],
      ["Closed", "q2", "dismissed"],
    ])
  })

  test("a question closed after it was answered, its answer not yet delivered, writes no Closed line: it was answered", () => {
    const open: Row = { id: "q1", sessionID: "ses_a", question: "Which port?", assume: "8080", askedAt: 1 }
    const answered: Row = { ...open, answered: { answer: "3000", delivery: "msg_1" } }
    const closing = [QuestionClosed.make({ id: "q1", reason: "dropped" })]
    const tags = (row: Row) => linesOf("ses_root", "ses_a", { next: 2, rows: [row] }, { next: 2, rows: [] }, closing, 5).map((event) => event._tag)
    expect([tags(answered), tags(open)]).toEqual([[], ["Closed"]])
  })

  test("a question put to an orchestrator is not the owner's, and writes nothing", async () => {
    const { run, lines } = rig()
    await run((model) => model.put("ses_child", { questions: [port] }, "ses_a", "Answer from the spec."))
    expect(lines()).toEqual([])
  })
})

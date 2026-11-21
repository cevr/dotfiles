// The page's answer, checked against what the log says the message asks before it goes: an option must be one of
// its own, a text not blank and within ANSWER_MAX, the message open; a question another answer closed is told that
// answer, where and when, and nothing is sent.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ANSWER_MAX, AnswerOutcome, type Answerers, answer, type ItemReply, type PageAnswer, type QuestionReply } from "./answers.ts"
import { DigestEvent as E, type DigestEvent, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"

const v = VERSION
const asked = E.cases.Asked.make({ v, t: 5, root: "r", session: "s", id: "q1", question: "Keep the old export?", header: Option.none(), options: ["Keep it", "Cut it"], assume: "Keep it" })
const item = E.cases.Item.make({
  v,
  t: 6,
  root: "r",
  id: "pay",
  text: "Pick the billing day.",
  state: "needs-you",
  owner: "mine",
  who: Option.none(),
  level: Option.none(),
  unit: Option.none(),
  choices: Option.some(["Monday", "Friday"]),
  answer: Option.none(),
})

/** The answer over a log of `events`, the plugins answering `question` and `queue`; what came of it, and what was sent. */
const run = (events: ReadonlyArray<DigestEvent>, input: PageAnswer, question: QuestionReply = { ok: true }, queue: ItemReply = { ok: true }) => {
  const sent: Array<string> = []
  const answerers: Answerers = {
    question: (session, id, given) => Effect.sync(() => void sent.push(`question ${session} ${id}: ${given}`)).pipe(Effect.as(question)),
    item: (root, id, given) => Effect.sync(() => void sent.push(`item ${root} ${id}: ${given}`)).pipe(Effect.as(queue)),
  }
  const outcome: AnswerOutcome = Effect.runSync(answer(Effect.succeed(fold(EMPTY, events)), answerers, input))
  return { outcome, sent }
}

describe("the page's answer", () => {
  test("an option of the question's own, or a text of his, goes to the questions plugin", () => {
    expect(run([asked], { id: "question:s:q1", option: "Cut it" })).toEqual({ outcome: AnswerOutcome.Answered({ replaced: Option.none() }), sent: ["question s q1: Cut it"] })
    expect(run([asked], { id: "question:s:q1", text: "  Keep it one more release  " }).sent).toEqual(["question s q1: Keep it one more release"])
  })

  test("an option not among the question's, a blank or too long text, both or neither is refused and nothing goes", () => {
    for (const [input, status] of [
      [{ id: "question:s:q1", option: "Delete everything" }, 400],
      [{ id: "question:s:q1", text: "   " }, 400],
      [{ id: "question:s:q1", text: "x".repeat(ANSWER_MAX + 1) }, 413],
      [{ id: "question:s:q1", option: "Cut it", text: "also this" }, 400],
      [{ id: "question:s:q1" }, 400],
      [{ id: "question:s:q9", option: "Cut it" }, 404],
      [{ id: "verdict:b1", option: "Cut it" }, 404],
    ] as const) {
      const { outcome, sent } = run([asked], input)
      expect([input.id, outcome._tag, outcome._tag === "Refused" && outcome.status, sent]).toEqual([input.id, "Refused", status, []])
    }
    expect(run([asked], { id: "question:s:q1", text: "x".repeat(ANSWER_MAX) }).sent).toHaveLength(1)
  })

  test("a question already answered is told that answer, where and when, and nothing goes", () => {
    const answered = E.cases.Answered.make({ v, t: 9, root: "r", session: "s", id: "q1", answer: "Keep it", matches: true, question: Option.none(), assume: Option.none(), via: Option.some("tray") })
    expect(run([asked, answered], { id: "question:s:q1", option: "Cut it" })).toEqual({
      outcome: AnswerOutcome.AlreadyClosed({ answer: Option.some("Keep it"), via: Option.some("tray"), at: Option.some(9) }),
      sent: [],
    })
  })

  test("when the plugin finds it closed first (the other answer not in the log yet), the page is told it was closed", () => {
    const { outcome } = run([asked], { id: "question:s:q1", option: "Cut it" }, { ok: false, message: "Question q1 is not open.", closed: true })
    expect(outcome).toEqual(AnswerOutcome.AlreadyClosed({ answer: Option.none(), via: Option.none(), at: Option.none() }))
  })

  test("a needs-you item takes one of its choices once; one he answered already is told his answer", () => {
    expect(run([item], { id: "item:r:pay", option: "Friday" }).sent).toEqual(["item r pay: Friday"])
    expect(run([item], { id: "item:r:pay", option: "Sunday" }).outcome._tag).toBe("Refused")
    const answered = { ...item, t: 7, answer: Option.some("Monday") }
    expect(run([item, answered], { id: "item:r:pay", option: "Friday" })).toEqual({ outcome: AnswerOutcome.AlreadyClosed({ answer: Option.some("Monday"), via: Option.none(), at: Option.some(7) }), sent: [] })
    expect(run([{ ...item, state: "running" }], { id: "item:r:pay", option: "Friday" }).outcome._tag).toBe("Refused")
  })
})

import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AskInput, commandOf, DESCRIPTION, explain, receipt } from "./ask.ts"
import { EmptyAnswer, InvalidQuestion, NothingAsked, NotOpen, UnknownQuestion } from "./question.ts"

test("a call becomes an Ask in the calling session; missing lists are empty", () => {
  const input = Schema.decodeUnknownSync(AskInput)({ questions: [{ question: "Port?", assume: "8080" }] })
  expect(commandOf("ses_a", input)).toEqual({ _tag: "Ask", sessionID: "ses_a", questions: [{ question: "Port?", assume: "8080" }], withdraw: [] })
  expect(commandOf("ses_a", { withdraw: ["q1"] }).questions).toEqual([])
})

test("the receipt lists each question with its id and assumption, what closed, and says to go on", () => {
  const text = receipt({
    opened: [{ id: "q3", sessionID: "ses_a", question: "Which port?", assume: "8080", askedAt: 0 }],
    closed: [
      { id: "q1", reason: "superseded" },
      { id: "q2", reason: "withdrawn" },
      { id: "q0", reason: "dropped" },
    ],
  })
  expect(text).toBe(
    [
      "Asked in the background; nobody has answered yet:",
      "- q3: Which port? · assuming 8080",
      "Withdrew: q2.",
      "Replaced (asked again): q1.",
      "Dropped (more than 8 open): q0.",
      "Continue on your assumption now. An answer arrives as a message in this session if the user gives one; if it differs from your assumption, revise the work that rests on it.",
    ].join("\n"),
  )
})

test("a withdraw-only receipt says only what was withdrawn", () => {
  expect(receipt({ opened: [], closed: [{ id: "q1", reason: "withdrawn" }] })).toBe("Withdrew: q1.")
})

test("each refusal reads as one sentence the agent can act on", () => {
  expect(explain(new NothingAsked({ reason: "give questions to ask, or ids to withdraw" }))).toBe("Nothing asked: give questions to ask, or ids to withdraw.")
  expect(explain(new InvalidQuestion({ index: 2, reason: "more than 4 options" }))).toBe("Question 2: more than 4 options. Nothing was asked.")
  expect(explain(new UnknownQuestion({ ids: ["q7"], open: [] }))).toBe("No open question q7 to withdraw. Open: none. Nothing was asked.")
  expect(explain(new NotOpen({ id: "q1" }))).toBe("Question q1 is not open.")
  expect(explain(new EmptyAnswer({ id: "q1" }))).toBe("The answer to q1 is empty.")
})

test("the description tells the agent it returns at once, where answers arrive and how to withdraw", () => {
  expect(DESCRIPTION).toContain("Returns immediately")
  expect(DESCRIPTION).toContain("/answer")
  expect(DESCRIPTION).toContain("withdraw: [id]")
})

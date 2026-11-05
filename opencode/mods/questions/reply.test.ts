import { expect, test } from "bun:test"
import type { Question } from "./question.ts"
import { excerpt, letterOf } from "./reply.ts"

const port: Question = {
  id: "q1",
  sessionID: "ses_a",
  question: "Which port should the dev server use?",
  header: "Port",
  assume: "8080",
  askedAt: Date.parse("2026-11-05T15:00:00Z"),
}

test("an answer that differs tells the agent to revise, naming question, assumption and answer", () => {
  const letter = letterOf(port, "3000")
  expect(letter.text).toBe(
    [
      "Answer to your background question q1 (asked 2026-11-05T15:00:00.000Z):",
      "Q: Which port should the dev server use?",
      "You assumed: 8080",
      "A: 3000",
      "This differs from your assumption: revise the work that rests on it, and say what you changed.",
    ].join("\n"),
  )
  expect(letter.description).toBe("answered · Which port should the dev server use? → 3000")
  expect(letter.metadata).toEqual({
    source: "questions",
    answers: [{ id: "q1", question: "Which port should the dev server use?", header: "Port", assume: "8080", answer: "3000", matches: false }],
  })
})

test("an answer that is the assumption tells the agent to carry on", () => {
  const letter = letterOf({ ...port, header: undefined }, " 8080")
  expect(letter.text.split("\n").at(-1)).toBe("This is what you assumed: carry on.")
  expect(letter.metadata.answers[0]?.matches).toBe(true)
  expect(letter.metadata.answers[0]).not.toHaveProperty("header")
})

test("the notice line keeps each side to one line and sixty characters", () => {
  const letter = letterOf({ ...port, question: `Which${" very".repeat(30)} long question?` }, "line one\nline two")
  const [question = "", answer = ""] = letter.description.replace("answered · ", "").split(" → ")
  expect([...question].length).toBe(60)
  expect(question.endsWith("…")).toBe(true)
  expect(answer).toBe("line one line two")
})

test("excerpt cuts on code points and leaves short text alone", () => {
  expect(excerpt("short", 10)).toBe("short")
  expect(excerpt("😀😀😀😀", 3)).toBe("😀😀…")
})

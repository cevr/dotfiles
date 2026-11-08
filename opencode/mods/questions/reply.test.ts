import { expect, test } from "bun:test"
import type { Question } from "./question.ts"
import { excerpt, letterOf, listed } from "./reply.ts"

const port: Question = {
  id: "q1",
  sessionID: "ses_a",
  question: "Which port should the dev server use?",
  header: "Port",
  assume: "8080",
  askedAt: Date.parse("2026-11-05T15:00:00Z"),
}
const flag: Question = { id: "q2", sessionID: "ses_a", question: "Keep the --legacy flag?", assume: "yes", askedAt: Date.parse("2026-11-05T15:01:00Z") }
const runner: Question = { id: "q4", sessionID: "ses_a", question: "Which test runner?", assume: "bun test", askedAt: Date.parse("2026-11-05T15:02:00Z") }

test("one answer that differs tells the agent to revise, naming question, assumption and answer", () => {
  const letter = letterOf([{ question: port, answer: "3000" }])
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

test("one answer that is the assumption tells the agent to carry on", () => {
  const letter = letterOf([{ question: { ...port, header: undefined }, answer: " 8080" }])
  expect(letter.text.split("\n").at(-1)).toBe("This is what you assumed: carry on.")
  expect(letter.metadata.answers[0]?.matches).toBe(true)
  expect(letter.metadata.answers[0]).not.toHaveProperty("header")
})

test("three answers are one letter: each question, assumption and answer, and one line naming what to revise", () => {
  const letter = letterOf([
    { question: port, answer: "3000" },
    { question: flag, answer: "Yes" },
    { question: runner, answer: "vitest" },
  ])
  expect(letter.text).toBe(
    [
      "Answers to your background questions q1, q2 and q4:",
      "",
      "q1 (asked 2026-11-05T15:00:00.000Z): Which port should the dev server use?",
      "You assumed: 8080",
      "A: 3000",
      "This differs from your assumption.",
      "",
      "q2 (asked 2026-11-05T15:01:00.000Z): Keep the --legacy flag?",
      "You assumed: yes",
      "A: Yes",
      "This is what you assumed.",
      "",
      "q4 (asked 2026-11-05T15:02:00.000Z): Which test runner?",
      "You assumed: bun test",
      "A: vitest",
      "This differs from your assumption.",
      "",
      "Revise the work that rests on q1 and q4, and say what you changed; the rest are what you assumed.",
    ].join("\n"),
  )
  expect(letter.description).toBe("answered 3 · Which port should the dev ser… → 3000 · Keep the --legacy flag? → Yes · Which test runner? → vitest")
  expect(letter.metadata.answers.map((answer) => [answer.id, answer.matches])).toEqual([
    ["q1", false],
    ["q2", true],
    ["q4", false],
  ])
})

test("several answers all as assumed say carry on; all differing say revise them all", () => {
  expect(letterOf([{ question: port, answer: "8080" }, { question: flag, answer: "yes" }]).text.split("\n").at(-1)).toBe("Each is what you assumed: carry on.")
  expect(letterOf([{ question: port, answer: "3000" }, { question: flag, answer: "no" }]).text.split("\n").at(-1)).toBe(
    "These differ from your assumptions: revise the work that rests on q1 and q2, and say what you changed.",
  )
})

test("a question dismissed beside an answer is named after it, in the same message", () => {
  const letter = letterOf([
    { question: port, answer: "3000" },
    { question: runner, answer: "bun test", dismissed: true },
  ])
  expect(letter.text).toBe(
    [
      "Answer to your background question q1 (asked 2026-11-05T15:00:00.000Z):",
      "Q: Which port should the dev server use?",
      "You assumed: 8080",
      "A: 3000",
      "This differs from your assumption: revise the work that rests on it, and say what you changed.",
      "",
      "q4 dismissed: your assumption stands (Which test runner? You assumed: bun test)",
    ].join("\n"),
  )
  expect(letter.description).toBe("answered · Which port should the dev server use? → 3000 · q4 dismissed")
  expect(letter.metadata.dismissed).toEqual(["q4"])
  expect(letter.metadata.answers.map((answer) => answer.id)).toEqual(["q1"])
})

test("with several answers, the dismissed ones follow the line naming what to revise", () => {
  const letter = letterOf([
    { question: port, answer: "8080" },
    { question: flag, answer: "yes", dismissed: true },
    { question: runner, answer: "bun test" },
  ])
  expect(letter.text).toStartWith("Answers to your background questions q1 and q4:")
  expect(letter.text).toEndWith(
    ["Each is what you assumed: carry on.", "", "q2 dismissed: your assumption stands (Keep the --legacy flag? You assumed: yes)"].join("\n"),
  )
  expect(letter.description).toEndWith("· q2 dismissed")
})

test("the notice line keeps each side to one line and sixty characters", () => {
  const letter = letterOf([{ question: { ...port, question: `Which${" very".repeat(30)} long question?` }, answer: "line one\nline two" }])
  const [question = "", answer = ""] = letter.description.replace("answered · ", "").split(" → ")
  expect([...question].length).toBe(60)
  expect(question.endsWith("…")).toBe(true)
  expect(answer).toBe("line one line two")
})

test("excerpt cuts on code points and leaves short text alone; listed joins with and", () => {
  expect(excerpt("short", 10)).toBe("short")
  expect(excerpt("😀😀😀😀", 3)).toBe("😀😀…")
  expect([listed(["q1"]), listed(["q1", "q2"]), listed(["q1", "q2", "q3"])]).toEqual(["q1", "q1 and q2", "q1, q2 and q3"])
})

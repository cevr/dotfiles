import { expect, test } from "bun:test"
import { ago, answerOf, ASSUMED, choicesOf, moved, paneTitle } from "./choices.ts"
import type { Question } from "./question.ts"

const port: Question = {
  id: "q1",
  sessionID: "ses_a",
  question: "Which port?",
  header: "Port",
  options: [{ label: "3000" }, { label: "8080", description: "the old default" }],
  assume: "8080",
  askedAt: 0,
}

test("the choice the agent assumed is marked, and the cursor starts on it", () => {
  expect(choicesOf(port)).toEqual({ rows: [{ label: "3000" }, { label: "8080", description: `${ASSUMED} · the old default` }], assumed: 1 })
})

test("an assumption no choice names becomes the first row", () => {
  expect(choicesOf({ ...port, assume: "4000" })).toEqual({
    rows: [{ label: "4000", description: ASSUMED }, { label: "3000" }, { label: "8080", description: "the old default" }],
    assumed: 0,
  })
  expect(choicesOf({ ...port, options: undefined }).rows).toEqual([{ label: "8080", description: ASSUMED }])
})

test("the cursor wraps over the choices and the free-text row", () => {
  const choices = choicesOf(port)
  expect(moved(1, 1, choices)).toBe(2)
  expect(moved(2, 1, choices)).toBe(0)
  expect(moved(0, -1, choices)).toBe(2)
})

test("enter sends typed text first, else the choice under the cursor, else nothing", () => {
  const choices = choicesOf(port)
  expect(answerOf(choices, 0, "  9000 ")).toBe("9000")
  expect(answerOf(choices, 1, "")).toBe("8080")
  expect(answerOf(choices, 2, " ")).toBeUndefined()
})

test("the title counts, labels, names another asker and says how long ago", () => {
  expect(paneTitle(port, 2, 3 * 60_000)).toBe("Question 1/2 · Port · asked 3m ago")
  expect(paneTitle({ ...port, header: undefined }, 1, 1000, "explore")).toBe("Question 1/1 · from explore · asked just now")
  expect([ago(30_000), ago(2 * 3_600_000), ago(3 * 86_400_000)]).toEqual(["30s ago", "2h ago", "3d ago"])
})

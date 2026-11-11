import { expect, test } from "bun:test"
import { Option } from "effect"
import { CHANGED } from "./question.ts"
import { changedSession, decodeOpen, sameQuestions } from "./reading.ts"

test("two readings say the same when every question matches in order; any other field, order or count differs", () => {
  const a = { id: "q1", sessionID: "ses_a", question: "Which DB?", assume: "sqlite", askedAt: 1 }
  const b = { id: "q2", sessionID: "ses_a", question: "Logs?", assume: "JSON", askedAt: 2 }
  expect(sameQuestions([a, b], [{ ...a }, { ...b }])).toBe(true)
  expect(sameQuestions([], [])).toBe(true)
  expect(sameQuestions([a, b], [b, a])).toBe(false)
  expect(sameQuestions([a], [a, b])).toBe(false)
  expect(sameQuestions([a], [{ ...a, assume: "postgres" }])).toBe(false)
})

test("a changed event names its session; any other event names none", () => {
  expect(changedSession({ type: CHANGED, data: { sessionID: "ses_a" } })).toBe("ses_a")
  expect(changedSession({ type: "session.updated", data: { sessionID: "ses_a" } })).toBeUndefined()
  expect(changedSession(undefined)).toBeUndefined()
})

test("an open answer decodes; anything else does not", () => {
  const question = { id: "q1", sessionID: "ses_a", question: "Which DB?", assume: "sqlite", askedAt: 1 }
  expect(decodeOpen({ questions: [question] })).toEqual(Option.some({ questions: [question] }))
  expect(Option.isNone(decodeOpen({ questions: [{ id: "q1" }] }))).toBe(true)
})

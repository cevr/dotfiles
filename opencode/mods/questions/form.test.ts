import { expect, test } from "bun:test"
import { DISMISS, DISMISS_VALUE, fieldOf, formOf, isOurs, KEY_PREFIX, replyOf } from "./form.ts"
import type { Question } from "./question.ts"

const AT = Date.parse("2026-11-05T15:00:00Z")
const cache: Question = {
  id: "q1",
  sessionID: "ses_a",
  question: "Which database should the cache use?",
  header: "Cache store",
  options: [{ label: "Redis" }, { label: "SQLite", description: "one file, no server" }],
  assume: "SQLite",
  askedAt: AT,
}
const endpoint: Question = { id: "q3", sessionID: "ses_a", question: "Should the old /v1 endpoint stay for a release?", assume: "Keep it", askedAt: AT + 1 }

test("a question is a string field with its choices, the assumed one first and marked, and a custom answer; no Dismiss choice", () => {
  expect(fieldOf(cache)).toEqual({
    key: "ask_user_async:q1",
    type: "string",
    title: "Cache store",
    description: "Which database should the cache use?",
    options: [
      { value: "SQLite", label: "SQLite", description: "assumed · one file, no server" },
      { value: "Redis", label: "Redis" },
    ],
    custom: true,
  })
})

test("with no choice naming it, the assumption is a choice of its own; with no header the tab is the question, cut", () => {
  expect(fieldOf(endpoint)).toEqual({
    key: "ask_user_async:q3",
    type: "string",
    title: "Should the old /v1 endp…",
    description: "Should the old /v1 endpoint stay for a release?",
    options: [{ value: "Keep it", label: "Keep it", description: "assumed" }],
    custom: true,
  })
})

test("a form holds every open question of the session, oldest first, and names an asker that is not on screen", () => {
  const form = formOf([endpoint, cache])
  expect(form?.title).toBe("Background questions")
  expect(form?.metadata).toEqual({ source: "questions" })
  expect(form?.fields.map((field) => field.key)).toEqual(["ask_user_async:q1", "ask_user_async:q3"])
  expect(formOf([cache], "general")?.metadata).toEqual({ source: "questions", message: "Asked by general" })
  expect(formOf([])).toBeUndefined()
  expect(isOurs(formOf([cache])!)).toBe(true)
  expect(isOurs({ fields: [{ key: "q0" }] })).toBe(false)
})

test("the form's one action is ctrl+x, dismiss, answering with the dismiss value and shown as dismissed", () => {
  expect(formOf([cache])?.actions).toEqual([{ key: "ctrl+x", label: "dismiss", value: "ask_user_async:dismiss", mark: "dismissed" }])
})

test("a reply gives the answers by question id, blank ones left out; another form's reply gives none", () => {
  expect(replyOf({ [`${KEY_PREFIX}q1`]: " Redis ", [`${KEY_PREFIX}q3`]: "", [`${KEY_PREFIX}q4`]: ["a", "b"] })).toEqual({
    answers: [
      { id: "q1", answer: "Redis" },
      { id: "q4", answer: "a, b" },
    ],
    dismissed: [],
  })
  expect(replyOf({ q0: "Redis" })).toBeUndefined()
  expect(replyOf({})).toBeUndefined()
})

test("a question the dismiss action answered is dismissed; the rest are answers", () => {
  expect(replyOf({ [`${KEY_PREFIX}q1`]: DISMISS_VALUE, [`${KEY_PREFIX}q3`]: "Keep it (note: log a warning)", [`${KEY_PREFIX}q4`]: "Redis" })).toEqual({
    answers: [
      { id: "q3", answer: "Keep it (note: log a warning)" },
      { id: "q4", answer: "Redis" },
    ],
    dismissed: ["q1"],
  })
  // A typed answer that reads like the action is an answer, not a dismissal.
  expect(replyOf({ [`${KEY_PREFIX}q1`]: DISMISS.label })).toEqual({ answers: [{ id: "q1", answer: "dismiss" }], dismissed: [] })
})

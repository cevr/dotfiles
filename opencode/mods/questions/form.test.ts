import { expect, test } from "bun:test"
import { answersOf, fieldOf, formOf, isOurs, KEY_PREFIX } from "./form.ts"
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

test("a question is a string field with its choices, the assumed one first and marked, and a custom answer", () => {
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

test("a reply gives the answers by question id, blank ones left out; another form's reply gives none", () => {
  expect(answersOf({ [`${KEY_PREFIX}q1`]: " Redis ", [`${KEY_PREFIX}q3`]: "", [`${KEY_PREFIX}q4`]: ["a", "b"] })).toEqual([
    { id: "q1", answer: "Redis" },
    { id: "q4", answer: "a, b" },
  ])
  expect(answersOf({ q0: "Redis" })).toBeUndefined()
  expect(answersOf({})).toBeUndefined()
})

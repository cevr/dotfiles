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
      { value: "SQLite", label: "SQLite (assumed)", description: "one file, no server" },
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
    options: [{ value: "Keep it", label: "Keep it (assumed)" }],
    custom: true,
  })
})

test("an assumed choice that is also the recommended one is one option, marked (recommended, assumed), answering with its label", () => {
  const logs: Question = {
    id: "q2",
    sessionID: "ses_a",
    question: "Should the logs be JSON?",
    options: [{ label: "Plain text" }, { label: "JSON (Recommended)", description: "what the reader parses" }],
    assume: "JSON",
    askedAt: AT,
  }
  expect(fieldOf(logs).options).toEqual([
    { value: "JSON (Recommended)", label: "JSON (recommended, assumed)", description: "what the reader parses" },
    { value: "Plain text", label: "Plain text" },
  ])
  // Picking it records what picking "JSON (Recommended)" recorded before: the choice's own label.
  const [picked] = fieldOf(logs).options
  expect(replyOf({ [`${KEY_PREFIX}q2`]: picked!.value }, "ses_a")).toEqual([{ sessionID: "ses_a", answers: [{ id: "q2", answer: "JSON (Recommended)" }], dismissed: [] }])
})

test("an assumption that starts with a choice's label marks that choice; one naming none stays its own option, marked", () => {
  const port = (assume: string): Question => ({
    id: "q4",
    sessionID: "ses_a",
    question: "Which port?",
    options: [{ label: "3000" }, { label: "8080" }],
    assume,
    askedAt: AT,
  })
  expect(fieldOf(port("8080, the dev default")).options).toEqual([
    { value: "8080", label: "8080 (assumed)" },
    { value: "3000", label: "3000" },
  ])
  expect(fieldOf(port("Use whichever is free")).options).toEqual([
    { value: "Use whichever is free", label: "Use whichever is free (assumed)" },
    { value: "3000", label: "3000" },
    { value: "8080", label: "8080" },
  ])
})

test("a form holds every open question of the session, oldest first", () => {
  const form = formOf([endpoint, cache])
  expect(form?.title).toBe("Background questions")
  expect(form?.metadata).toEqual({ source: "questions" })
  expect(form?.fields.map((field) => field.key)).toEqual(["ask_user_async:q1", "ask_user_async:q3"])
  expect(formOf([])).toBeUndefined()
  expect(isOurs(formOf([cache])!)).toBe(true)
  expect(isOurs({ fields: [{ key: "q0" }] })).toBe(false)
})

test("in the session on screen, its subagents' questions follow its own in the one form, keyed by their session and naming who asked", () => {
  const sub: Question = { ...cache, id: "q1", sessionID: "ses_child", askedAt: AT - 5 }
  const form = formOf([sub, endpoint, cache], "ses_a", (sessionID) => (sessionID === "ses_child" ? "implementor auth r1" : sessionID))
  expect(form?.fields.map((field) => [field.key, field.title, field.description])).toEqual([
    ["ask_user_async:q1", "Cache store", "Which database should the cache use?"],
    ["ask_user_async:q3", "Should the old /v1 endp…", "Should the old /v1 endpoint stay for a release?"],
    ["ask_user_async:ses_child:q1", "Cache store", "implementor auth r1 asks: Which database should the cache use?"],
  ])
  expect(fieldOf(sub, "implementor auth r1").options).toEqual(fieldOf(cache).options)
})

test("the form's one action is ctrl+x, dismiss, answering with the dismiss value and shown as dismissed", () => {
  expect(formOf([cache])?.actions).toEqual([{ key: "ctrl+x", label: "dismiss", value: "ask_user_async:dismiss", mark: "dismissed" }])
})

test("a reply gives the answers by question id, blank ones left out; another form's reply gives none", () => {
  expect(replyOf({ [`${KEY_PREFIX}q1`]: " Redis ", [`${KEY_PREFIX}q3`]: "", [`${KEY_PREFIX}q4`]: ["a", "b"] }, "ses_a")).toEqual([
    {
      sessionID: "ses_a",
      answers: [
        { id: "q1", answer: "Redis" },
        { id: "q4", answer: "a, b" },
      ],
      dismissed: [],
    },
  ])
  expect(replyOf({ q0: "Redis" }, "ses_a")).toBeUndefined()
  expect(replyOf({}, "ses_a")).toBeUndefined()
})

test("a question the dismiss action answered is dismissed; the rest are answers", () => {
  expect(replyOf({ [`${KEY_PREFIX}q1`]: DISMISS_VALUE, [`${KEY_PREFIX}q3`]: "Keep it (note: log a warning)", [`${KEY_PREFIX}q4`]: "Redis" }, "ses_a")).toEqual([
    {
      sessionID: "ses_a",
      answers: [
        { id: "q3", answer: "Keep it (note: log a warning)" },
        { id: "q4", answer: "Redis" },
      ],
      dismissed: ["q1"],
    },
  ])
  // A typed answer that reads like the action is an answer, not a dismissal.
  expect(replyOf({ [`${KEY_PREFIX}q1`]: DISMISS.label }, "ses_a")).toEqual([{ sessionID: "ses_a", answers: [{ id: "q1", answer: "dismiss" }], dismissed: [] }])
})

test("a reply that answers subagents too gives each asking session its own, the subagents' first and the form's session last", () => {
  expect(
    replyOf(
      {
        [`${KEY_PREFIX}q1`]: "Redis",
        [`${KEY_PREFIX}ses_child:q1`]: "vitest",
        [`${KEY_PREFIX}ses_child:q2`]: DISMISS_VALUE,
        [`${KEY_PREFIX}ses_other:q4`]: "",
      },
      "ses_root",
    ),
  ).toEqual([
    { sessionID: "ses_child", answers: [{ id: "q1", answer: "vitest" }], dismissed: ["q2"] },
    { sessionID: "ses_root", answers: [{ id: "q1", answer: "Redis" }], dismissed: [] },
  ])
})

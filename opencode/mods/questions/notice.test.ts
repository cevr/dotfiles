// The notice the root session gets when a subagent's question is answered,
// and the name of the subagent that asked.
import { expect, test } from "bun:test"
import { askerOf } from "./asker.ts"
import type { Question } from "./question.ts"
import { noticeOf } from "./reply.ts"

const AT = Date.parse("2026-11-05T15:00:00Z")
const cache: Question = { id: "q31", sessionID: "ses_child", question: "Which database should the cache use?", header: "Cache store", assume: "SQLite", askedAt: AT }
const flag: Question = { id: "q32", sessionID: "ses_child", question: "Keep the --legacy flag?", assume: "yes", askedAt: AT + 1 }
const runner: Question = { id: "q33", sessionID: "ses_child", question: "Which test runner?", assume: "bun test", askedAt: AT + 2 }
const asker = { sessionID: "ses_child", name: "implementor auth r1" }

test("a subagent is named by its title, with its agent unless the title names it; else its agent, else its id", () => {
  expect(askerOf({ id: "ses_child", title: "implementor auth r1", agent: "implementor" })).toBe("implementor auth r1")
  expect(askerOf({ id: "ses_child", title: "Runner check", agent: "general" })).toBe("Runner check (general)")
  expect(askerOf({ id: "ses_child", title: "  ", agent: "general" })).toBe("general")
  expect(askerOf({ id: "ses_child" })).toBe("ses_child")
})

test("one answer: the notice names the subagent, the question, its assumption and the answer, and says the subagent has it", () => {
  const notice = noticeOf(asker, [{ question: cache, answer: "Redis" }])
  expect(notice.text).toBe(
    [
      "The subagent implementor auth r1 had its background question q31 answered; the answer went to it:",
      "Q: Which database should the cache use?",
      "It assumed: SQLite",
      "A: Redis (differs from its assumption)",
      "",
      "The subagent revises its own work on it; this is for your record.",
    ].join("\n"),
  )
  expect(notice.description).toBe("implementor auth r1's question q31 answered · Which database should the cache use? → Redis")
  expect(notice.metadata).toEqual({
    source: "questions",
    notice: { sessionID: "ses_child", asker: "implementor auth r1" },
    answers: [{ id: "q31", question: "Which database should the cache use?", header: "Cache store", assume: "SQLite", answer: "Redis", matches: false }],
  })
})

test("several answers and a dismissal in one submit: one notice listing each", () => {
  const notice = noticeOf(asker, [
    { question: cache, answer: "SQLite" },
    { question: flag, answer: "no" },
    { question: runner, answer: "bun test", dismissed: true },
  ])
  expect(notice.text).toBe(
    [
      "The subagent implementor auth r1 had its background questions q31 and q32 answered; the answers went to it:",
      "",
      "q31: Which database should the cache use?",
      "It assumed: SQLite",
      "A: SQLite (as it assumed)",
      "",
      "q32: Keep the --legacy flag?",
      "It assumed: yes",
      "A: no (differs from its assumption)",
      "",
      "q33 dismissed: its assumption stands (Which test runner? It assumed: bun test)",
      "",
      "The subagent revises its own work on them; this is for your record.",
    ].join("\n"),
  )
  expect(notice.description).toBe(
    "implementor auth r1's questions answered 2 · Which database should the cac… → SQLite · Keep the --legacy flag? → no · q33 dismissed",
  )
  expect(notice.metadata.dismissed).toEqual(["q33"])
  expect(notice.metadata.notice).toEqual({ sessionID: "ses_child", asker: "implementor auth r1" })
})

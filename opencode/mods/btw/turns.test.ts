import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { forkTurns, ownMessages, preview, PREVIEW_CHARS, replyOf } from "./turns.ts"

const user = (id: string, text: string, created: number) => ({ type: "user", id, text, time: { created } })
const assistant = (id: string, content: ReadonlyArray<unknown>, created: number, error?: string) => ({
  type: "assistant",
  id,
  content,
  ...(error === undefined ? {} : { error: { type: "provider", message: error } }),
  time: { created, completed: created + 1 },
})
const text = (value: string) => ({ type: "text", id: "p", text: value })

// Copied from the session at times before the fork (100); the fork's own from 100 on.
const copied = [user("msg_1", "build it", 10), assistant("msg_2", [text("Building.")], 11)]

describe("forkTurns", () => {
  test("pairs each of the fork's own questions with its answer, skipping the copied history and the hidden note", () => {
    const messages = [
      ...copied,
      { type: "synthetic", id: "msg_3", text: "the note", time: { created: 100 } },
      user("msg_4", "why?", 101),
      assistant("msg_5", [{ type: "reasoning", text: "hm" }, text("Because")], 102),
      assistant("msg_6", [{ type: "tool", name: "read" }, text("it is cold.")], 103),
      user("msg_7", "and?", 104),
    ]
    expect(forkTurns(messages, 100)).toEqual([
      { question: "why?", answer: "Because\n\nit is cold.", replyID: "msg_6" },
      { question: "and?", answer: "" },
    ])
  })

  test("a failed step carries its error, and a step with no text keeps the answer so far", () => {
    const messages = [user("msg_4", "why?", 101), assistant("msg_5", [text("Partly")], 102), assistant("msg_6", [], 103, "rate limited")]
    expect(forkTurns(messages, 100)).toEqual([{ question: "why?", answer: "Partly", replyID: "msg_6", error: "rate limited" }])
  })

  test("messages it cannot read are skipped", () => {
    expect(forkTurns([null, 3, { type: "user" }, user("msg_4", "why?", 101), { type: "assistant", time: { created: 102 } }], 100)).toEqual([
      { question: "why?", answer: "" },
    ])
  })

  test("an answer with no question before it is not a turn", () => {
    expect(forkTurns([assistant("msg_5", [text("orphan")], 101)], 100)).toEqual([])
  })
})

test("ownMessages keeps the messages made at or after the fork", () => {
  expect(ownMessages([...copied, user("msg_4", "why?", 100)], 100)).toEqual([user("msg_4", "why?", 100)])
})

describe("replyOf", () => {
  const answered = { question: "why?", answer: "Because.", replyID: "msg_6" }
  test("is the newest answered turn", () => {
    expect(replyOf([{ question: "a", answer: "b", replyID: "msg_1" }, answered], false)).toEqual(Option.some({ replyID: "msg_6", question: "why?", answer: "Because." }))
  })
  test("is none while replying, before any answer, or for a blank answer", () => {
    expect(replyOf([answered], true)).toEqual(Option.none())
    expect(replyOf([{ question: "why?", answer: "" }], false)).toEqual(Option.none())
    expect(replyOf([{ ...answered, answer: "  " }], false)).toEqual(Option.none())
    expect(replyOf([], false)).toEqual(Option.none())
  })
})

test("preview is one line of at most PREVIEW_CHARS characters", () => {
  expect(preview("a\nb")).toBe("a b")
  expect(preview("x".repeat(PREVIEW_CHARS + 1))).toBe(`${"x".repeat(PREVIEW_CHARS)}…`)
})

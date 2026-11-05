import { expect, test } from "bun:test"
import { ANSWER_CHARS, bringBackDescription, bringBackID, bringBackText } from "./bring-back.ts"

const reply = { replyID: "msg_abc", question: "why is it slow?", answer: "The cache is cold." }

test("one message id per fork reply, in the host's message id form", () => {
  expect(bringBackID("msg_abc")).toBe("msg_btw_abc")
  expect(bringBackID("abc")).toBe("msg_btw_abc")
})

test("the text names the fork and carries the question and the answer", () => {
  expect(bringBackText({ sessionID: "ses_fork", name: "btw: why\nis it slow?" }, reply)).toBe(
    [
      'The user brought back an answer from a /btw side question: "btw: why is it slow?" (session ses_fork).',
      "That session began as a copy of this one and ran beside it in the same directory; what it said is not otherwise in this conversation.",
      "",
      "Question:",
      "why is it slow?",
      "",
      "Answer:",
      "The cache is cold.",
    ].join("\n"),
  )
})

test("a long answer is cut at ANSWER_CHARS", () => {
  const text = bringBackText({ sessionID: "s", name: "btw" }, { ...reply, answer: "y".repeat(ANSWER_CHARS + 5) })
  expect(text.endsWith(`${"y".repeat(ANSWER_CHARS)}…`)).toBe(true)
})

test("the notice row reads btw · and the question on one line", () => {
  expect(bringBackDescription({ ...reply, question: "why\nis it slow?" })).toBe("btw · why is it slow?")
})

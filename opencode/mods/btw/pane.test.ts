import { describe, expect, test } from "bun:test"
import { canBringBack, hints, paneTitle, rows } from "./pane.ts"

const fork = { sessionID: "ses_fork", name: "btw: why?", createdAt: 1, broughtBack: [] }

test("the title is the fork's name, or btw before there is one", () => {
  expect(paneTitle(fork)).toBe("btw: why?")
  expect(paneTitle(undefined)).toBe("btw")
})

describe("rows", () => {
  test("an answer streams while the fork replies to the newest question", () => {
    expect(rows([{ question: "why?", answer: "Because", replyID: "msg_1" }], true, undefined)).toEqual([
      { _tag: "Answer", question: "why?", answer: "Because", streaming: true },
    ])
    expect(rows([{ question: "why?", answer: "Because.", replyID: "msg_1" }], false, undefined)).toEqual([
      { _tag: "Answer", question: "why?", answer: "Because.", streaming: false },
    ])
  })

  test("a question with no text yet is thinking while the fork replies, else has no answer, with its error", () => {
    expect(rows([{ question: "why?", answer: "" }], true, undefined)).toEqual([{ _tag: "Waiting", question: "why?", note: "thinking…" }])
    expect(rows([{ question: "why?", answer: "", replyID: "msg_1", error: "rate limited" }], false, undefined)).toEqual([
      { _tag: "Waiting", question: "why?", note: "no answer", error: "rate limited" },
    ])
  })

  test("a question on its way shows after the fork's own until its turn appears", () => {
    expect(rows([], false, "why?")).toEqual([{ _tag: "Waiting", question: "why?", note: "forking…" }])
    const answered = { question: "why?", answer: "Because.", replyID: "msg_1" }
    expect(rows([answered], false, "and?").at(-1)).toEqual({ _tag: "Waiting", question: "and?", note: "asking…" })
    expect(rows([answered, { question: "and?", answer: "" }], true, "and?")).toHaveLength(2)
  })
})

describe("hints", () => {
  test("enter opens the fork on an empty line and asks otherwise", () => {
    expect(hints({ draft: "", fork: true, canBringBack: false })).toBe("enter open · esc close")
    expect(hints({ draft: "and?", fork: true, canBringBack: false })).toBe("enter ask · esc close")
    expect(hints({ draft: "", fork: false, canBringBack: false })).toBe("enter ask · esc close")
  })

  test("ctrl+s shows when an answer can come back", () => {
    expect(hints({ draft: "", fork: true, canBringBack: true })).toBe("enter open · ctrl+s bring back · esc close")
  })
})

test("an answer can come back once it is finished and not brought back already", () => {
  const turns = [{ question: "why?", answer: "Because.", replyID: "msg_1" }]
  expect(canBringBack(fork, turns, false)).toBe(true)
  expect(canBringBack(fork, turns, true)).toBe(false)
  expect(canBringBack({ ...fork, broughtBack: ["msg_1"] }, turns, false)).toBe(false)
  expect(canBringBack(undefined, turns, false)).toBe(false)
})

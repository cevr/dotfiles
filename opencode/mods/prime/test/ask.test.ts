// The pinned ask: which prompt governs the top of the view, and its one line.
import { describe, expect, test } from "bun:test"
import { governingAsk, isAsk, oneLine, type Message } from "../src/ask"

const user = (id: string, text = `ask ${id}`): Message => ({ id, type: "user", text })
const other = (id: string, type: string): Message => ({ id, type })

// ask 1, its answer, a mail steer, ask 2, its answer, a completion notice.
const messages = [
  user("u1"),
  other("a1", "assistant"),
  { id: "m1", type: "synthetic", text: "mail from another session" },
  user("u2"),
  other("a2", "assistant"),
  other("n1", "system"),
]

describe("the ask pinned over the transcript", () => {
  test("only a prompt the reader wrote is an ask", () => {
    expect(isAsk(user("u"))).toBe(true)
    expect(isAsk(user("u", "  \n "))).toBe(false)
    for (const type of ["synthetic", "system", "compaction", "shell", "skill", "assistant"])
      expect(isAsk({ id: "x", type, text: "words" })).toBe(false)
  })

  test("the ask governing the top row is the newest one at or above it", () => {
    // Scrolled into answer 1: ask 1 is above the view.
    expect(
      governingAsk(messages, [
        { messageID: "u1", row: -12 },
        { messageID: "a1", row: -10 },
        { messageID: "u2", row: 8 },
      ])?.id,
    ).toBe("u1")
    // Into answer 2, past a mail steer that sits above ask 2.
    expect(
      governingAsk(messages, [
        { messageID: "a1", row: -30 },
        { messageID: "m1", row: -20 },
        { messageID: "u2", row: -14 },
        { messageID: "a2", row: -12 },
        { messageID: "n1", row: 3 },
      ])?.id,
    ).toBe("u2")
    // A notice at the top answers to the ask before it.
    expect(
      governingAsk(messages, [
        { messageID: "u2", row: -14 },
        { messageID: "a2", row: -12 },
        { messageID: "n1", row: 0 },
      ])?.id,
    ).toBe("u2")
    // The mail steer at the top, ask 2 below: ask 1 governs.
    expect(
      governingAsk(messages, [
        { messageID: "m1", row: -1 },
        { messageID: "u2", row: 4 },
      ])?.id,
    ).toBe("u1")
  })

  test("nothing is pinned while the ask's own first row is the top row, or above every message", () => {
    expect(
      governingAsk(messages, [
        { messageID: "u2", row: 0 },
        { messageID: "a2", row: 2 },
      ]),
    ).toBeUndefined()
    expect(
      governingAsk(messages, [
        { messageID: "u1", row: 4 },
        { messageID: "a1", row: 6 },
      ]),
    ).toBeUndefined()
    expect(governingAsk(messages, [])).toBeUndefined()
    // A subagent's transcript opens with its prompt: the same rule.
    expect(
      governingAsk(
        [user("p", "the brief"), other("a", "assistant")],
        [
          { messageID: "p", row: -3 },
          { messageID: "a", row: -1 },
        ],
      )?.text,
    ).toBe("the brief")
  })

  test("the ask draws on one line: whitespace collapses, an ellipsis cuts it at the width", () => {
    expect(oneLine("fix the\n\n  parser\tnow ", 40)).toBe("fix the parser now")
    expect(oneLine("fix the parser now", 10)).toBe("fix the p…")
    expect(Array.from(oneLine("fix the parser now", 10)).length).toBeLessThanOrEqual(10)
    expect(oneLine("fix the parser now", 18)).toBe("fix the parser now")
    expect(oneLine("fix", Infinity)).toBe("fix")
  })
})

// The pinned ask: which prompt governs the top of the view, and its one line.
import { describe, expect, test } from "bun:test"
import { EMPTY_INDEX, governingAsk, isAsk, oneLine, pinnedAsk, PROMPT_LENGTH, promptOf, withLoaded, withPage, type Message } from "./ask.ts"

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

  describe("outside the loaded window (the side channel)", () => {
    // The window holds only the end of a long turn: its prompt u9 and every one before it are not loaded.
    const window = [other("s27", "assistant"), other("s28", "assistant"), other("s29", "assistant")]
    const rows = [
      { messageID: "s27", row: -6 },
      { messageID: "s28", row: -2 },
      { messageID: "s29", row: 5 },
    ]
    const prompt = (id: string, time: number) => ({ id, time, text: `ask ${id}` })
    const page = [prompt("u9", 9), prompt("u8", 8)]

    test("the pin is the newest prompt the window does not hold; before the first page it asks for one", () => {
      expect(pinnedAsk(window, rows, EMPTY_INDEX)).toEqual({ ask: undefined, wants: true })
      const index = withPage(EMPTY_INDEX, page, "cursor-2")
      expect(pinnedAsk(window, rows, index)).toEqual({ ask: prompt("u9", 9), wants: false })
      // At the bottom of the view nothing above the top changes it; above every mounted row nothing pins.
      expect(pinnedAsk(window, [], index)).toEqual({ ask: undefined, wants: false })
    })

    test("a loaded ask above the top still wins, and one at the top shows itself", () => {
      const loaded = [user("u9"), ...window]
      const index = withPage(EMPTY_INDEX, page, undefined)
      expect(pinnedAsk(loaded, [{ messageID: "u9", row: -9 }, ...rows], index).ask?.id).toBe("u9")
      expect(pinnedAsk(loaded, [{ messageID: "u9", row: 0 }, { messageID: "s27", row: 3 }], index).ask).toBeUndefined()
    })

    test("once the window holds every prompt in the index it reads a page more, until the session's start", () => {
      const loaded = [user("u8"), other("a8", "assistant"), user("u9"), ...window]
      const top = [{ messageID: "u8", row: -1 }]
      // u8's own row is above the top: the loaded rule.
      expect(pinnedAsk(loaded, top, withPage(EMPTY_INDEX, page, "cursor-2")).ask?.id).toBe("u8")
      // The window's oldest message is a step whose prompt is u7, not loaded and not yet read.
      const deeper = [other("a7", "assistant"), ...loaded]
      const index = withPage(EMPTY_INDEX, page, "cursor-2")
      expect(pinnedAsk(deeper, [{ messageID: "a7", row: -1 }], index)).toEqual({ ask: undefined, wants: true })
      const more = withPage(index, [prompt("u7", 7), prompt("u8", 8)], undefined)
      expect(more.prompts.map((each) => each.id)).toEqual(["u9", "u8", "u7"])
      expect(pinnedAsk(deeper, [{ messageID: "a7", row: -1 }], more)).toEqual({ ask: prompt("u7", 7), wants: false })
      // The session's start was read: nothing more to ask for.
      expect(pinnedAsk([other("a0", "assistant")], [{ messageID: "a0", row: -1 }], withPage(EMPTY_INDEX, [], undefined))).toEqual({ ask: undefined, wants: false })
    })

    test("a new prompt joins the index's head, and stays once the window no longer holds it", () => {
      const index = withPage(EMPTY_INDEX, page, "cursor-2")
      const arrived = withLoaded(index, [
        { ...user("u9"), time: { created: 9 } },
        { ...other("a9", "assistant"), time: { created: 9.5 } },
        { ...user("u10", "the new ask"), time: { created: 10 } },
        { ...user("u11", "  "), time: { created: 11 } },
      ])
      expect(arrived.prompts.map((each) => each.id)).toEqual(["u10", "u9", "u8"])
      expect(withLoaded(arrived, [{ ...user("u10"), time: { created: 10 } }])).toBe(arrived)
      // A re-read window of only u10's steps: the pin still names u10.
      expect(pinnedAsk(window, rows, arrived).ask?.text).toBe("the new ask")
      // Before the first page nothing is kept: that page brings them.
      expect(withLoaded(EMPTY_INDEX, [{ ...user("u10"), time: { created: 10 } }])).toBe(EMPTY_INDEX)
    })

    test("the index keeps a prompt on one line, cut short, and no prompt without words", () => {
      const long = "x".repeat(500)
      expect(promptOf({ id: "u", type: "user", text: `fix\n\n  it ${long}`, time: { created: 1 } })?.text).toHaveLength(PROMPT_LENGTH)
      expect(promptOf({ id: "u", type: "user", text: "fix\n it", time: { created: 1 } })).toEqual({ id: "u", time: 1, text: "fix it" })
      expect(promptOf({ id: "u", type: "user", text: " " })).toBeUndefined()
    })
  })

  test("the ask draws on one line: whitespace collapses, an ellipsis cuts it at the width", () => {
    expect(oneLine("fix the\n\n  parser\tnow ", 40)).toBe("fix the parser now")
    expect(oneLine("fix the parser now", 10)).toBe("fix the p…")
    expect(Array.from(oneLine("fix the parser now", 10)).length).toBeLessThanOrEqual(10)
    expect(oneLine("fix the parser now", 18)).toBe("fix the parser now")
    expect(oneLine("fix", Infinity)).toBe("fix")
  })
})

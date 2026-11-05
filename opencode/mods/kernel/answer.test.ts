// The CellAnswer view: what the model reads of one call's events.
import { describe, expect, test } from "bun:test"
import { fold } from "@dotfiles/decider/decider"
import { CellAnswer, read } from "./answer.ts"
import { CellRan, KernelLost, KernelReset, KernelSessionId, KernelStarted, type Event } from "./session.ts"

const session = KernelSessionId.make("ses_1")

const cell = (fields: Partial<Omit<CellRan, "_tag" | "session">> = {}) =>
  CellRan.make({ session, ok: true, output: "", display: "", unkept: [], stored: true, ...fields })

/** What the model reads of one call's events. */
const answer = (events: ReadonlyArray<Event>, viewChars = 8_000) => read(fold(CellAnswer, events), viewChars)

describe("the answer", () => {
  test("is the notes, then the cell's own output, then its display", () => {
    expect(
      answer([
        KernelReset.make({ session }),
        KernelStarted.make({ session, restored: ["n"] }),
        cell({ output: "raw\n", display: "42", unkept: [{ name: "f", reason: "function" }] }),
      ]),
    ).toEqual({ ok: true, text: "[kernel reset]\n[new kernel; restored n]\n[not kept across restarts: f (function)]\nraw\n42" })
  })

  test("of a cell that printed nothing is '(no output)'; one that threw is the tool's error", () => {
    expect(answer([cell()])).toEqual({ ok: true, text: "(no output)" })
    expect(answer([cell({ ok: false, display: "TypeError: boom" })])).toEqual({ ok: false, text: "TypeError: boom" })
  })

  test("carries the files a cell attached; a cell that threw attaches nothing", () => {
    expect(answer([cell({ display: "attached 1 image: a.png", attached: ["/w/a.png"] })])).toEqual({
      ok: true,
      text: "attached 1 image: a.png",
      attached: ["/w/a.png"],
    })
    expect(answer([cell({ ok: false, display: "Error: after", attached: ["/w/a.png"] })])).toEqual({ ok: false, text: "Error: after" })
  })

  test("keeps the head and tail of long output, within the view", () => {
    const { text } = answer([cell({ display: `${"a".repeat(300)}END` })], 100)
    expect(text.length).toBeLessThan(160)
    expect(text.startsWith("a".repeat(50))).toBe(true)
    expect(text.endsWith("END")).toBe(true)
    expect(text).toContain("characters omitted")
  })

  test("of a lost worker is its reason, after the notes, as the tool's error", () => {
    expect(answer([KernelReset.make({ session }), KernelLost.make({ session, message: "The kernel worker exited (code 5)" })])).toEqual({
      ok: false,
      text: "[kernel reset]\nThe kernel worker exited (code 5)",
    })
  })
})

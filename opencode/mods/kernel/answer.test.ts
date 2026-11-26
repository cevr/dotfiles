// The CellAnswer view: what the model reads of one call's events.
import { describe, expect, test } from "bun:test"
import { fold } from "@dotfiles/decider/decider"
import { CellAnswer, read } from "./answer.ts"
import { lostOf } from "./model.ts"
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
        KernelStarted.make({ session, restored: ["n"], lost: ["m"] }),
        cell({ output: "raw\n", display: "42", unkept: [{ name: "f", reason: "function" }] }),
      ]),
    ).toEqual({
      ok: true,
      text: "[kernel reset]\n[new kernel; 1 binding restored, 1 lost: m; kernel.bindings() lists what it holds]\n[not kept across restarts: f (function)]\nraw\n42",
    })
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

// Law W5c, as acceptance/notice.test.ts states it: a new kernel says so only when something was lost,
// as counts, a few lost names and the call that lists the rest, never the names it restored.
describe("a new kernel's notice", () => {
  const names = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}_${index}`)
  const started = (restored: ReadonlyArray<string>, lost: ReadonlyArray<string>) =>
    answer([KernelStarted.make({ session, restored, ...(lost.length > 0 ? { lost } : {}) }), cell({ display: "2" })]).text

  test("is absent when the kernel restored everything: a planned drop is not news", () => {
    const text = started(names(600, "binding"), [])
    expect(text).not.toContain("new kernel")
    expect(text).not.toContain("binding_300")
    expect(text).toBe("2")
  })

  test("of a kernel that lost something is one short line: the counts, a few lost names, and how to list the rest", () => {
    const [notice] = started(names(600, "binding"), names(40, "lost")).split("\n")
    expect(notice).toBe("[new kernel; 600 bindings restored, 40 lost: lost_0, lost_1, lost_2 and 37 more; kernel.bindings() lists what it holds]")
  })

  test("stays within 160 characters for every count from 1 to 5,000, dropping names before the counts", () => {
    for (const count of [0, 1, 2, 9, 10, 99, 600, 4_999, 5_000])
      for (const lost of [1, 3, Math.max(count, 1)]) {
        const [notice] = started(names(count, "a_rather_long_binding_name"), names(lost, "another_rather_long_binding_name")).split("\n")
        expect(notice!.length, `${count} restored, ${lost} lost`).toBeLessThanOrEqual(160)
        expect(notice, `${count} restored, ${lost} lost`).toContain(`${lost} lost`)
        expect(notice, `${count} restored, ${lost} lost`).toContain("another_rather_long_binding_name_0")
      }
    expect(started([], ["x".repeat(200)]).split("\n")[0]).toBe("[new kernel; 0 bindings restored, 1 lost; kernel.bindings() lists what it holds]")
  })

  test("names at most 8 bindings a cell made that a restart cannot keep, the rest as a count", () => {
    const unkept = Array.from({ length: 40 }, (_, index) => ({ name: `live_${index}`, reason: "live" as const }))
    const { text } = answer([cell({ unkept })])
    expect(text).toContain("live_0 (live)")
    expect(text).toContain("live_7 (live)")
    expect(text).not.toContain("live_8")
    expect(text).toContain("… and 32 more")
  })
})

describe("the lost names", () => {
  test("are the stored names the new worker did not define, once each; a bare import has none", () => {
    const stored = ["", "f", "kept", "big", "f"].map((name) => ({ name, value: null }))
    expect(lostOf(stored, ["f", "kept"])).toEqual(["big"])
    expect(lostOf(stored, ["f", "kept", "big"])).toEqual([])
  })
})

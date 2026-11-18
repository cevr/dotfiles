import { describe, expect, test } from "bun:test"
import { board, type Live } from "./board.ts"
import type { Item } from "./item.ts"
import { plan, planText, segments, tally } from "./plan.ts"

/** 2026-11-05 15:00 UTC; no line here shows a time. */
const NOW = 1_793_890_800_000

const item = (id: string, state: Item["state"], extra: Partial<Item> = {}): Item => ({ id, text: id, state, owner: "mine", ...extra })
const text = (items: ReadonlyArray<Item>, live: ReadonlyMap<string, Live> = new Map()) => plan(items, live, NOW).map(planText)

describe("plan", () => {
  test("an item the owner answered says so until the agent writes it again", () => {
    expect(text([item("panes", "needs-you", { text: "Close old panes", answered: { answer: "Still needed", at: NOW } })])).toEqual([
      "! Close old panes · needs you · answered: Still needed",
    ])
  })

  test("nests what waits on an item, and what its outcomes lead to, under it; draws each outcome", () => {
    const items = [
      item("land", "next", { text: "Land + install", after: ["verify"] }),
      item("impl", "next", {
        text: "Money parsing r1",
        session: "ses_impl",
        on: { accepted: "verify", failed: "tell the owner" },
      }),
      item("verify", "next", { text: "Verify money parsing", after: ["impl", "plan"], on: { changes: "fix round 2" } }),
      item("panes", "needs-you", { text: "Close old panes" }),
      item("plan", "done", { text: "Plan", doneAt: NOW - 1000 }),
    ]
    expect(text(items, new Map([["ses_impl", { state: "running" }]]))).toEqual([
      "! Close old panes · needs you",
      "● Money parsing r1 · running",
      "  on accepted ⇥ ○ Verify money parsing",
      "  on failed   ⇥ tell the owner",
      "│ ○ Verify money parsing · next",
      "│   after ✓ Plan",
      "│   on changes ⇥ fix round 2",
      "│ │ ○ Land + install · next",
      "✓ Plan · done",
    ])
  })

  test("an item whose parent dropped off the board stands at the left, naming what it waited on", () => {
    expect(text([item("old", "done", { doneAt: NOW - 3_600_000 }), item("next", "next", { after: ["old"] })])).toEqual(["○ next · next", "  after old"])
  })

  test("a cycle is drawn once, from its first item in the board's order, and ends", () => {
    const items = [
      item("a", "next", { after: ["b"] }),
      item("b", "running", { after: ["c"] }),
      item("c", "next", { after: ["a"], on: { done: "b" } }),
    ]
    expect(text(items)).toEqual(["● b · running", "  after ○ c", "│ ○ a · next", "│ │ ○ c · next", "│ │   on done ⇥ ● b"])
  })

  test("colours the mark and the state word by the row's mark, the arrow and the guide apart", () => {
    const lines = plan([item("a", "running", { on: { ok: "b" } }), item("b", "next", { owner: "other", who: "wC:p6" })], new Map(), NOW)
    expect(segments(lines[0]!)).toEqual([
      { text: "", tone: "guide" },
      { text: "● ", tone: "running" },
      { text: "a", tone: "text" },
      { text: " · running", tone: "running" },
    ])
    expect(segments(lines[1]!).map((segment) => segment.tone)).toEqual(["guide", "label", "text", "arrow", "next", "text"])
    expect(planText(lines[2]!)).toBe("│ ○ b · next · wC:p6")
  })
})

describe("tally", () => {
  test("counts what is not done, and what needs the owner", () => {
    const rows = board([item("a", "needs-you"), item("b", "running"), item("c", "done", { doneAt: NOW }), item("d", "next", { session: "s" })], new Map([["s", { state: "blocked" }]]), NOW)
    expect(tally(rows)).toEqual({ open: 3, needsYou: 2 })
  })
})

import { describe, expect, test } from "bun:test"
import { board, line, LINGER_MS, type Live, when } from "./board.ts"
import type { Item } from "./item.ts"

// Local times, so the expectations hold in any time zone.
const NOW = new Date(2026, 10, 4, 15, 0).getTime()
const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).toISOString()

const item = (id: string, state: Item["state"], extra: Partial<Item> = {}): Item => ({ id, text: id, state, owner: "mine", ...extra })

describe("when", () => {
  test("a time today is the clock; another day adds the date; nonsense is nothing", () => {
    expect(when(at(4, 22, 7), NOW)).toBe("22:07")
    expect(when(at(5, 9, 30), NOW)).toBe("Nov 5 09:30")
    expect(when("soon", NOW)).toBeUndefined()
  })
})

describe("board", () => {
  test("groups needs-you, running, waiting, scheduled by time, next, done, keeping the queue's order within a group", () => {
    const rows = board(
      [
        item("n1", "next"),
        item("late", "scheduled", { at: at(5, 9, 0) }),
        item("w", "waiting", { owner: "other", who: "wC:p6" }),
        item("d", "done", { doneAt: NOW - 1000 }),
        item("soon", "scheduled", { at: at(4, 22, 7), detail: "cron" }),
        item("r", "running"),
        item("you", "needs-you"),
        item("n2", "next"),
      ],
      new Map(),
      NOW,
    )
    expect(rows.map((row) => row.key)).toEqual(["you", "r", "w", "soon", "late", "n1", "n2", "d"])
    expect(rows.find((row) => row.key === "soon")).toEqual({ key: "soon", group: "scheduled", mark: "scheduled", text: "soon", time: "22:07", detail: "cron" })
    expect(rows.find((row) => row.key === "w")).toEqual({ key: "w", group: "waiting", mark: "waiting", text: "w", who: "wC:p6" })
  })

  test("a done item lingers, then drops off the board", () => {
    const done = [item("d", "done", { doneAt: NOW })]
    expect(board(done, new Map(), NOW + LINGER_MS - 1).map((row) => row.key)).toEqual(["d"])
    expect(board(done, new Map(), NOW + LINGER_MS)).toEqual([])
    expect(board(done, new Map(), NOW + 60_000, 30_000)).toEqual([])
  })

  test("an item linked to a subagent shows its live state, not the item's", () => {
    const live = new Map<string, Live>([
      ["ses_run", { state: "running" }],
      ["ses_ask", { state: "blocked" }],
      ["ses_ok", { state: "done", since: NOW - 1000 }],
      ["ses_old", { state: "done", since: NOW - LINGER_MS }],
      ["ses_bad", { state: "failed", since: NOW - 10 * LINGER_MS }],
    ])
    const rows = board(
      [
        item("run", "next", { session: "ses_run" }),
        item("ask", "running", { session: "ses_ask" }),
        item("ok", "running", { session: "ses_ok" }),
        item("old", "running", { session: "ses_old" }),
        item("bad", "running", { session: "ses_bad" }),
        item("unseen", "waiting", { session: "ses_elsewhere" }),
      ],
      live,
      NOW,
    )
    expect(rows.map((row) => [row.key, row.group, row.mark])).toEqual([
      ["ask", "needs-you", "blocked"],
      ["run", "running", "running"],
      ["unseen", "waiting", "waiting"],
      ["ok", "done", "done"],
      ["bad", "done", "failed"],
    ])
  })

  test("the board is the queue's items only: a subagent no item names draws no row, and a linked row is one line", () => {
    const rows = board(
      [item("mine", "next", { session: "ses_a" })],
      new Map<string, Live>([
        ["ses_a", { state: "running" }],
        ["ses_b", { state: "running" }],
        ["ses_c", { state: "blocked" }],
      ]),
      NOW,
    )
    expect(rows).toEqual([{ key: "mine", group: "running", mark: "running", text: "mine" }])
    expect(board([], new Map<string, Live>([["ses_b", { state: "running" }]]), NOW)).toEqual([])
  })
})

describe("line", () => {
  test("marks the row, shows a scheduled time, the detail and whose it is, cut to the width", () => {
    expect(line({ key: "a", group: "needs-you", mark: "needs-you", text: "Close old Claude panes" }, 37)).toBe("! Close old Claude panes")
    expect(line({ key: "b", group: "scheduled", mark: "scheduled", text: "pool-token check", time: "22:07" }, 37)).toBe("◷ 22:07 pool-token check")
    expect(line({ key: "c", group: "waiting", mark: "waiting", text: "manna brainstorm", who: "wC:p6" }, 37)).toBe("… manna brainstorm · wC:p6")
    expect(line({ key: "d", group: "running", mark: "running", text: "A very long description of the worker's task", detail: "pane 3" }, 20)).toBe(
      "● A very long descr…",
    )
  })
})

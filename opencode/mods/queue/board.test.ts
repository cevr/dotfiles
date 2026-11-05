import { describe, expect, test } from "bun:test"
import { agentLine, board, line, LINGER_MS, roleWidth, type Subagent, when } from "./board.ts"
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
      [],
      NOW,
    )
    expect(rows.map((row) => row.key)).toEqual(["you", "r", "w", "soon", "late", "n1", "n2", "d"])
    expect(rows.find((row) => row.key === "soon")).toEqual({ key: "soon", group: "scheduled", mark: "scheduled", text: "soon", time: "22:07", detail: "cron" })
    expect(rows.find((row) => row.key === "w")).toEqual({ key: "w", group: "waiting", mark: "waiting", text: "w", who: "wC:p6" })
  })

  test("a done item lingers, then drops off the board", () => {
    const done = [item("d", "done", { doneAt: NOW })]
    expect(board(done, [], NOW + LINGER_MS - 1).map((row) => row.key)).toEqual(["d"])
    expect(board(done, [], NOW + LINGER_MS)).toEqual([])
    expect(board(done, [], NOW + 60_000, 30_000)).toEqual([])
  })

  test("an item linked to a subagent shows its live state, not the item's", () => {
    const subagents: ReadonlyArray<Subagent> = [
      { session: "ses_run", description: "Fix money parsing", live: { state: "running" } },
      { session: "ses_ask", description: "Ask", live: { state: "blocked" } },
      { session: "ses_ok", description: "Ok", live: { state: "done", since: NOW - 1000 } },
      { session: "ses_old", description: "Old", live: { state: "done", since: NOW - LINGER_MS } },
      { session: "ses_bad", description: "Bad", live: { state: "failed", since: NOW - 10 * LINGER_MS } },
    ]
    const rows = board(
      [
        item("run", "next", { session: "ses_run" }),
        item("ask", "running", { session: "ses_ask" }),
        item("ok", "running", { session: "ses_ok" }),
        item("old", "running", { session: "ses_old" }),
        item("bad", "running", { session: "ses_bad" }),
        item("unseen", "waiting", { session: "ses_elsewhere" }),
      ],
      subagents,
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

  test("running and blocked subagents no item names join the board under their description", () => {
    const rows = board(
      [item("mine", "running", { session: "ses_a" })],
      [
        { session: "ses_a", description: "Named", live: { state: "running" } },
        { session: "ses_b", description: "Forgotten worker", live: { state: "running" } },
        { session: "ses_c", description: "Waiting on a permission", live: { state: "blocked" } },
        { session: "ses_d", description: "Finished", live: { state: "done" } },
        { session: "ses_e", description: "Failed", live: { state: "failed" } },
      ],
      NOW,
    )
    expect(rows).toEqual([
      { key: "session:ses_c", group: "needs-you", mark: "blocked", text: "Waiting on a permission" },
      { key: "mine", group: "running", mark: "running", text: "mine" },
      { key: "session:ses_b", group: "running", mark: "running", text: "Forgotten worker" },
    ])
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

describe("a subagent's role and update", () => {
  test("a linked row and an unnamed running subagent carry the role, the update and the time", () => {
    const rows = board(
      [item("money", "next", { session: "ses_a", text: "Money parsing worker" })],
      [
        { session: "ses_a", description: "Fix money parsing", live: { state: "running" }, role: "implementor", update: "editing src/money.ts", elapsed: 65_000 },
        { session: "ses_b", description: "Forgotten worker", live: { state: "running" }, role: "worker", update: "starting" },
        { session: "ses_c", description: "No role known", live: { state: "running" } },
      ],
      NOW,
    )
    expect(rows.map((row) => row.agent)).toEqual([
      { role: "implementor", update: "editing src/money.ts", elapsed: 65_000 },
      { role: "worker", update: "starting" },
      undefined,
    ])
    expect(roleWidth(rows)).toBe(11)
  })

  test("the second line pads the role to the board's widest and lets the update give way first", () => {
    const agent = { role: "worker", update: "editing src/money.ts", elapsed: 65_000 }
    expect(agentLine(agent, 37, 11)).toBe("  worker       editing src/… · 1m 05s")
    expect(agentLine(agent, 37)).toBe("  worker  editing src/money… · 1m 05s")
    expect(agentLine(agent, 60)).toBe("  worker  editing src/money.ts · 1m 05s")
    expect(agentLine({ role: "implementor", update: "editing src/money.ts" }, 30)).toBe("  implementor  editing src/mo…")
    expect(agentLine({ role: "implementor", update: "editing", elapsed: 1000 }, 18)).toBe("  implementor")
  })
})

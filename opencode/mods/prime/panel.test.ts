import { describe, expect, test } from "bun:test"
import type { Row } from "@dotfiles/opencode-subagents/subagent-row"
import { alarmLine, footer, layout, monitorLine, shellLine, subagentLine, tabBar, widths, type Cell, type Line } from "./panel.ts"
import type { ShellEntry } from "./shells.ts"
import type { WakeEntry } from "./wakes.ts"

/** 2026-11-12, in epoch ms: the rows read only differences from it. */
const NOW = 1_794_517_200_000
const MINUTE = 60_000

const row = (over: Partial<Row>): Row => ({
  id: "ses_corpus",
  depth: 0,
  role: "implementor",
  tone: "implementor",
  model: { name: "opus", version: "5.5" },
  unit: "Corpus HP",
  state: "working",
  update: "editing src/corpus.ts",
  since: NOW - 220 * MINUTE,
  heard: NOW - 13 * MINUTE,
  ...over,
})

const text = (cells: ReadonlyArray<Pick<Cell, "text">>) => cells.map((cell) => cell.text).join("")
const drawn = (lines: ReadonlyArray<Line>, width: number) => lines.map((line) => text(layout(line, widths(lines), width)))

describe("a subagent's row", () => {
  test("says the role, the model, the name, what it does, its state and how long, and when it was last heard from", () => {
    const line = subagentLine(row({}), NOW, "◆")
    const shown = text(layout(line, widths([line]), 160))
    expect(shown).toStartWith("◆ implementor opus 5.5  Corpus HP  editing src/corpus.ts  ")
    // What it last did takes the room between, so the state and the times sit at the right.
    expect(shown).toEndWith("  working  3h 40m  updated 13m ago")
    expect(Array.from(shown)).toHaveLength(160)
  })

  test("its time ticks with the clock", () => {
    const at = (now: number) => {
      const line = subagentLine(row({ since: NOW - 5_000, heard: NOW }), now, "◆")
      return text(layout(line, widths([line]), 80))
    }
    expect(at(NOW)).toEndWith("working  5s")
    expect(at(NOW + 1_000)).toEndWith("working  6s")
    expect(at(NOW + 61_000)).toEndWith("working  1m 06s")
  })

  test("a stopped one shows no running time, and says when it ended", () => {
    const line = subagentLine(row({ state: "done", update: "landed 3 commits", ended: NOW - 4 * MINUTE }), NOW, "◆")
    expect(line).toMatchObject({ glyph: "◆", tone: "muted", state: "done", time: "", stale: "ended 4m 00s ago" })
  })
})

describe("the rows of a tab", () => {
  const lines = [
    subagentLine(row({}), NOW, "◆"),
    subagentLine(row({ id: "b", role: "verifier", tone: "verifier", model: { name: "sol", version: "6.1" }, unit: "EX3 later clauses", update: "flock gate.lock ./gate.sh", since: NOW - 37 * MINUTE, heard: NOW - 26 * MINUTE }), NOW, "◆"),
    subagentLine(row({ id: "c", role: "planner", tone: "planner", unit: "MONO1", state: "waiting", update: "waits on 2 shells", since: NOW - 9_000, heard: NOW - 9_000 }), NOW, "◆"),
  ]

  test("share their columns: the names start, and the times end, at one place", () => {
    const shown = drawn(lines, 120)
    const starts = ["Corpus HP", "EX3 later clauses", "MONO1"].map((name, at) => (shown[at] ?? "").indexOf(name))
    expect(new Set(starts).size).toBe(1)
    const ends = ["3h 40m", "37m", "9s"].map((time, at) => (shown[at] ?? "").indexOf(time) + time.length)
    expect(new Set(ends).size).toBe(1)
  })

  test("drop their parts in turn as the width shrinks, the name and the time last", () => {
    const at = (width: number) => drawn(lines, width)[0] ?? ""
    expect(at(90)).toBe("◆ implementor opus 5.5  Corpus HP          editing src/…  working  3h 40m  updated 13m ago")
    expect(at(80)).toBe("◆ implementor opus 5.5  Corpus HP          editing src/corpus.…  working  3h 40m")
    expect(at(70)).toBe("◆ implementor opus  Corpus HP          editing src/c…  working  3h 40m")
    expect(at(60)).toBe("◆ implementor  Corpus HP          editing src/corpu…  3h 40m")
    expect(at(50)).toBe("◆ implementor  Corpus HP          3h 40m")
    expect(at(30)).toBe("◆ Corpus HP          3h 40m")
    expect(at(20)).toBe("◆ Corpus HP   3h 40m")
    expect(at(12)).toBe("◆ C…  3h 40m")
    for (const width of [160, 120, 100, 90, 80, 70, 50, 40, 30, 20, 12])
      for (const each of drawn(lines, width)) expect(Array.from(each).length).toBeLessThanOrEqual(width)
  })
})

describe("the other tabs' rows", () => {
  test("a shell command: its description, its last output line, running and for how long", () => {
    const shell: ShellEntry = {
      id: "sh_1",
      status: "running",
      command: "bun test",
      metadata: { description: "run the suite" },
      time: { started: NOW - 65_000 },
    }
    const line = shellLine(shell, NOW, "ok 1\nok 12 passed\n\n", "◇")
    expect(line).toMatchObject({ glyph: "◇", tone: "success", name: "run the suite", status: "ok 12 passed", state: "running", time: "1m 05s" })
    expect(shellLine({ ...shell, status: "exited", exit: 1, time: { started: NOW - 5_000, completed: NOW - 1_000 } }, NOW, "", "◇")).toMatchObject({
      tone: "error",
      status: "no output yet",
      state: "exited 1",
      time: "4s",
    })
  })

  const wake: WakeEntry = { id: "w1", kind: "alarm", dueAt: NOW + 252_000, note: "Check CI\nthen land", mode: "wake" }

  test("an alarm: its note, its mode and repeat, and how long until it is due", () => {
    expect(alarmLine(wake, NOW)).toMatchObject({ name: "Check CI", status: "wake · once", state: "pending", time: "in 4m 12s", tone: "info" })
    expect(alarmLine(wake, NOW + 300_000)).toMatchObject({ state: "due", time: "now", tone: "warning" })
  })

  test("a monitor: its command, its newest output line, how long it has watched and when it last checked", () => {
    const monitor: WakeEntry = {
      ...wake,
      kind: "monitor",
      command: "gh pr checks 12",
      setAt: NOW - 12 * MINUTE,
      last: { at: NOW - 30_000, exitCode: 1, output: "build pending\n" },
    }
    expect(monitorLine(monitor, NOW, "◆")).toMatchObject({
      name: "gh pr checks 12",
      status: "build pending",
      state: "watching",
      time: "12m",
      stale: "checked 30s ago",
    })
  })
})

describe("the tab bar and the footer", () => {
  const tabs = [
    { id: "subagents", label: "Subagents" },
    { id: "shell", label: "Shell" },
    { id: "terminals", label: "Terminals" },
    { id: "wakes", label: "Wakes" },
  ]
  const counts = new Map([["subagents", 5], ["shell", 2], ["wakes", 1]])

  test("each tab with how many it lists, between dots; narrower, the counts drop, then the dots", () => {
    expect(text(tabBar(tabs, "shell", counts, 80))).toBe("Subagents 5  ·  Shell 2  ·  Terminals  ·  Wakes 1")
    expect(tabBar(tabs, "shell", counts, 80).filter((cell) => cell.kind === "active")).toEqual([{ text: "Shell", kind: "active", id: "shell" }])
    expect(text(tabBar(tabs, "shell", counts, 45))).toBe("Subagents  ·  Shell  ·  Terminals  ·  Wakes")
    expect(text(tabBar(tabs, "shell", counts, 30))).toBe("Subagents  Shell  Terminals  …")
  })

  test("the footer names each key the way Prime's hint line does", () => {
    const hints = [
      { label: "interrupt", shortcut: "ctrl+d" },
      { label: "show inactive", shortcut: "ctrl+a" },
      { label: "unbound", shortcut: "" },
    ]
    expect(text(footer(hints, 5))).toBe("Ctrl+D interrupt · Ctrl+A show inactive · ←/→ tabs")
    expect(text(footer([], 1))).toBe("")
  })
})

import { describe, expect, test } from "bun:test"
import { EMPTY, sameWakeItem, span, tabEntries, wakeDetail, wakeItem, wakeRow, type WakeEntry, type Wakes } from "./wakes.ts"

const NOW = new Date(2026, 10, 5, 13, 0).getTime()
/** An entry with a placeholder id, note and mode: the dock's item reads only the kind. */
const entry = (over: Pick<WakeEntry, "kind" | "dueAt"> & Partial<WakeEntry>): WakeEntry => ({ id: "w000000", note: "a note", mode: "wake", ...over })
const wakes = (entries: ReadonlyArray<Pick<WakeEntry, "kind" | "dueAt"> & Partial<WakeEntry>>, notices = 0): Wakes => ({
  now: NOW,
  entries: entries.map(entry),
  notices,
})

describe("the dock's wake item", () => {
  test("nothing pending or unread, nothing shown", () => {
    expect(wakeItem(wakes([]), 80)).toBeUndefined()
  })

  test("counts wakes, monitors and unread notices, plain, in the success colour", () => {
    const pending = wakes(
      [
        { kind: "alarm", dueAt: NOW + 3_600_000 },
        { kind: "alarm", dueAt: NOW + 5_400_000 },
        { kind: "monitor", dueAt: NOW + 60_000 },
      ],
      1,
    )
    expect(wakeItem(pending, 80)).toEqual({ text: "2 wakes · 1 monitor · 1 notice", tone: "success" })
  })

  test("only monitors", () => {
    expect(wakeItem(wakes([{ kind: "monitor", dueAt: NOW + 60_000 }]), 80)?.text).toBe("1 monitor")
  })

  test("only notices unread: the warning colour", () => {
    expect(wakeItem(wakes([], 1), 80)).toEqual({ text: "1 notice", tone: "warning" })
  })

  test("parts drop from the right as the width shrinks, keeping the first", () => {
    const pending = wakes([{ kind: "alarm", dueAt: NOW + 60_000 }, { kind: "monitor", dueAt: NOW + 60_000 }], 1)
    expect(wakeItem(pending, 29)?.text).toBe("1 wake · 1 monitor · 1 notice")
    expect(wakeItem(pending, 28)?.text).toBe("1 wake · 1 monitor")
    expect(wakeItem(pending, 18)?.text).toBe("1 wake · 1 monitor")
    expect(wakeItem(pending, 17)?.text).toBe("1 wake")
    expect(wakeItem(pending, 1)?.text).toBe("1 wake")
  })

  test("a reading that says the same draws the same item, so the dock keeps it on its 2-second read", () => {
    const first = wakeItem(wakes([{ kind: "alarm", dueAt: NOW + 3_600_000 }]), 80)
    // Two seconds on, the server's clock moved and the entry is the same.
    const again = wakeItem({ ...wakes([{ kind: "alarm", dueAt: NOW + 3_600_000 }]), now: NOW + 2000 }, 80)
    expect(again).not.toBe(first)
    expect(sameWakeItem(first, again)).toBe(true)
    expect(sameWakeItem(first, wakeItem(wakes([{ kind: "alarm", dueAt: NOW }, { kind: "alarm", dueAt: NOW }]), 80))).toBe(false)
    expect(sameWakeItem(first, wakeItem(wakes([], 1), 80))).toBe(false)
    // Nothing pending draws no item, the same each time.
    const none = wakeItem(wakes([]), 80)
    expect(sameWakeItem(none, wakeItem({ ...wakes([]), now: NOW + 2000 }, 80))).toBe(true)
    expect(sameWakeItem(first, none)).toBe(false)
  })
})

const alarm = entry({ id: "walpha1", kind: "alarm", dueAt: NOW + 600_000, note: "ALPHA: check the deploy\nthen report" })
const monitor = entry({
  id: "wgamma1",
  kind: "monitor",
  dueAt: NOW + 1_800_000,
  note: "GAMMA: the service is up",
  command: "echo still-waiting",
  intervalSeconds: 1,
  until: "^READY$",
  last: { at: NOW - 1000, exitCode: 0, output: "booting\nstill-waiting\n" },
})

describe("the composer panel's Wakes and Monitors tabs", () => {
  test("each tab lists its own kind, soonest first", () => {
    const later = entry({ id: "wlater1", kind: "alarm", dueAt: NOW + 7_200_000 })
    const reading = wakes([later, monitor, alarm])
    expect(tabEntries(reading, "alarm").map((each) => each.id)).toEqual(["walpha1", "wlater1"])
    expect(tabEntries(reading, "monitor").map((each) => each.id)).toEqual(["wgamma1"])
  })

  test("an empty tab says so, before the first reading too", () => {
    expect(tabEntries(undefined, "alarm")).toEqual([])
    expect(tabEntries(wakes([monitor]), "alarm")).toEqual([])
    expect(EMPTY).toEqual({ alarm: "No pending wakes", monitor: "No monitors" })
  })

  test("an alarm's row: when it is due, its note's first line, its mode, its repeat", () => {
    expect(wakeRow(alarm, NOW)).toBe("13:10 in 10m · ALPHA: check the deploy · wake · once")
    expect(wakeRow({ ...alarm, mode: "notify", everySeconds: 3600 }, NOW)).toBe("13:10 in 10m · ALPHA: check the deploy · notify · every 1h")
  })

  test("an alarm on another day names the day; one past its time is due now", () => {
    expect(wakeRow({ ...alarm, dueAt: NOW + 25 * 3_600_000 }, NOW)).toStartWith("Nov 6 14:00 in 1d 1h · ")
    expect(wakeRow({ ...alarm, dueAt: NOW - 5000 }, NOW)).toStartWith("12:59 due now · ")
  })

  test("a monitor's row: its command, its period, what it stops on, its newest output line", () => {
    expect(wakeRow(monitor, NOW)).toBe("echo still-waiting · every 1s · until /^READY$/ · still-waiting")
    expect(wakeRow({ ...monitor, until: undefined, last: undefined }, NOW)).toBe("echo still-waiting · every 1s · until exit 0 · not checked yet")
    expect(wakeRow({ ...monitor, last: { at: NOW, exitCode: 1, output: "" } }, NOW)).toEndWith(" · exit 1, no output")
  })

  test("long free text is clipped to keep the row on one line", () => {
    expect(wakeRow({ ...alarm, note: "x".repeat(80) }, NOW)).toBe(`13:10 in 10m · ${"x".repeat(47)}… · wake · once`)
  })

  test("Enter's detail holds the whole entry: the full note, the full output", () => {
    expect(wakeDetail(alarm, NOW)).toEqual({
      title: "Wake walpha1",
      message: "Due: 13:10 in 10m\nRepeat: once\nMode: wake: its fire starts a turn\n\nALPHA: check the deploy\nthen report",
    })
    expect(wakeDetail(monitor, NOW)).toEqual({
      title: "Monitor wgamma1",
      message: [
        "Command: echo still-waiting",
        "Checks: every 1s, until /^READY$/",
        "Gives up: 13:30 in 30m",
        "Mode: wake: its fire starts a turn",
        "",
        "Last check: 12:59, exit 0",
        "booting\nstill-waiting\n",
        "",
        "GAMMA: the service is up",
      ].join("\n"),
    })
  })

  test("a span reads in its two largest units", () => {
    expect([span(45), span(600), span(605), span(3600), span(7500), span(90_000), span(86_400)]).toEqual(["45s", "10m", "10m 05s", "1h", "2h 05m", "1d 1h", "1d"])
  })
})

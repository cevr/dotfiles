// A subagent row drawn as one line.
import { describe, expect, test } from "bun:test"
import { columns, duration, fit, format, glyph, SPINNER, STALE_MS, stateTone, SYMBOLS, type FormatOptions } from "./line.ts"
import type { Row, State } from "./subagent-row.ts"

const OPUS = { name: "opus", version: "5.5" }
const row = (over: Partial<Row>): Row => ({
  id: "a",
  depth: 0,
  role: "implementor",
  tone: "implementor",
  model: OPUS,
  unit: "Fix money parsing",
  state: "working",
  update: "editing src/money.ts",
  since: 0,
  elapsed: 72_000,
  ...over,
})
const line = (value: Row, width: number, options: FormatOptions = {}) =>
  format(value, width, { spinner: "◆", ...options })
    .map((segment) => segment.text)
    .join("")
const MIN = 60_000
// The owner's pkg-lower lane: queued on the gate lock for 37 minutes, last heard from 26 minutes ago.
const stuck = row({
  role: "worker",
  tone: "worker",
  unit: "pkg-lower implementor",
  state: "waiting",
  update: "flock gate.lock ./scripts/gate.sh",
  elapsed: 37 * MIN,
  quiet: 26 * MIN,
})
const STATES: ReadonlyArray<State> = ["working", "waiting", "blocked", "idle", "cancelled", "done", "failed"]
const WORDS = /(^|\s)(working|waiting|blocked|idle|cancelled|done|failed)(\s|$)/

describe("the state diamonds", () => {
  test("each diamond and spinner frame is one cell wide, from the Geometric Shapes block", () => {
    for (const symbol of [...STATES.map((state) => SYMBOLS[state]), ...Array.from(SPINNER)]) {
      expect(Array.from(symbol)).toHaveLength(1)
      expect(Bun.stringWidth(symbol)).toBe(1)
      const code = symbol.codePointAt(0) ?? 0
      expect(code >= 0x25a0 && code <= 0x25ff).toBe(true)
    }
    expect(Array.from(SPINNER)).toEqual(["◆", "◇"])
  })

  test("still, every state differs from every other by diamond and colour", () => {
    const looks = STATES.map((state) => `${SYMBOLS[state]} ${stateTone(state)}`)
    expect(new Set(looks).size).toBe(STATES.length)
    expect(Object.fromEntries(STATES.map((state) => [state, `${SYMBOLS[state]} ${stateTone(state)}`]))).toEqual({
      working: "◈ success",
      waiting: "◈ warning",
      blocked: "◆ warning",
      idle: "◇ muted",
      cancelled: "◇ warning",
      done: "◆ muted",
      failed: "◆ error",
    })
  })

  test("the diamond pulses full then empty, 600 ms each, only for a working row", () => {
    expect(glyph("working", "◇")).toBe("◇")
    expect(glyph("waiting", "◇")).toBe(SYMBOLS.waiting)
    expect([0, 599, 600, 1199, 1200].map((ms) => format(row({ elapsed: ms }), 80)[0]?.text)).toEqual(["◆ ", "◆ ", "◇ ", "◇ ", "◆ "])
    expect(format(row({ state: "waiting", elapsed: 250 }), 80)[0]?.text).toBe("◈ ")
  })
})

describe("a drawn row", () => {
  test("the state is the leading diamond, never a word; a live row then says what it does and how long it has been in that state", () => {
    expect(line(row({}), 80)).toBe("◆ implementor opus 5.5  Fix money parsing  editing src/money.ts · 1m 12s")
    expect(line(row({ state: "waiting", update: "polling gate-r2.log" }), 80)).toBe(
      "◈ implementor opus 5.5  Fix money parsing  polling gate-r2.log · 1m 12s",
    )
    expect(line(row({ state: "blocked", update: "question: Which?" }), 80)).toBe(
      "◆ implementor opus 5.5  Fix money parsing  question: Which? · 1m 12s",
    )
    expect(line(row({ state: "done", update: "3 steps", since: undefined, elapsed: undefined }), 80)).toBe(
      "◆ implementor opus 5.5  Fix money parsing  3 steps",
    )
    expect(line(row({ state: "failed", update: "boom", elapsed: undefined }), 80)).toBe("◆ implementor opus 5.5  Fix money parsing  boom")
    expect(line(row({ state: "cancelled", update: "", elapsed: undefined }), 80)).toBe("◇ implementor opus 5.5  Fix money parsing")
    expect(line(row({ state: "idle", update: "", elapsed: undefined }), 80)).toBe("◇ implementor opus 5.5  Fix money parsing")
    for (const state of STATES) expect(line(row({ state, update: "" }), 80).slice(2)).not.toMatch(WORDS)
  })

  test("each part has its kind, for its colour", () => {
    const kinds = (value: Row) => format(value, 80).map((segment) => segment.kind)
    expect(kinds(row({}))).toEqual(["lead", "role", "faint", "model", "faint", "unit", "faint", "update", "faint", "time"])
    expect(kinds(row({ update: "" }))).toEqual(["lead", "role", "faint", "model", "faint", "unit", "faint", "time"])
    expect(kinds(row({ model: undefined }))).toEqual(["lead", "role", "faint", "unit", "faint", "update", "faint", "time"])
  })

  test("a stale update says how long ago it was, after the time", () => {
    expect(line(stuck, 120)).toBe("◈ worker opus 5.5  pkg-lower implementor  flock gate.lock ./scripts/gate.sh · 37m · updated 26m ago")
    expect(format(stuck, 120).at(-1)).toEqual({ text: "updated 26m ago", kind: "stale" })
  })

  test("a fresh update, or one as old as the state's time, says no age", () => {
    expect(line(row({ quiet: STALE_MS - 1 }), 120)).not.toContain("updated")
    // The update came when the wait began: `37m` already says it.
    expect(line(row({ state: "waiting", elapsed: 37 * MIN, quiet: 37 * MIN - 30_000 }), 120)).not.toContain("updated")
    expect(line(row({ state: "working", elapsed: 58 * MIN, quiet: 28 * MIN }), 120)).toEndWith(" · 58m · updated 28m ago")
  })

  test("times read as precisely as they are worth", () => {
    expect([12_000, 72_000, 9 * MIN + 59_000, 37 * MIN + 11_000, 68 * MIN + 11_000].map(duration)).toEqual(["12s", "1m 12s", "9m 59s", "37m", "1h 08m"])
  })

  test("roles, models and units line up across rows; a long unit is cut", () => {
    const rows = [
      row({}),
      row({ id: "b", role: "planner", model: { name: "sol", version: "6.1" }, unit: "A very long unit of work that goes on and on" }),
      row({ id: "c", role: "worker", model: undefined, unit: "Short" }),
    ]
    const cols = columns(rows)
    expect(cols).toEqual({ role: 11, model: 8, name: 4, unit: 28 })
    const [first = "", second = "", third = ""] = rows.map((value) => line(value, 100, { columns: cols }))
    expect(second).toStartWith("◆ planner     sol 6.1   A very long unit of work th…  editing")
    expect(first).toStartWith("◆ implementor opus 5.5  Fix money parsing             editing")
    expect(third).toStartWith("◆ worker                Short                         editing")
  })

  test("as the width shrinks, parts drop from the right: the update's age, the model's version, the update, then the line is cut", () => {
    const widths = [120, 90, 80, 62, 61, 50, 30, 0]
    expect(widths.map((width) => line(stuck, width))).toEqual([
      "◈ worker opus 5.5  pkg-lower implementor  flock gate.lock ./scripts/gate.sh · 37m · updated 26m ago",
      "◈ worker opus 5.5  pkg-lower implementor  flock gate.lock ./scrip… · 37m · updated 26m ago",
      "◈ worker opus 5.5  pkg-lower implementor  flock gate.lock ./scripts/gate.… · 37m",
      "◈ worker opus 5.5  pkg-lower implementor  flock gate.lo… · 37m",
      "◈ worker opus  pkg-lower implementor  flock gate.lock… · 37m",
      "◈ worker opus  pkg-lower implementor  37m",
      "◈ worker opus  pkg-lower impl…",
      "",
    ])
    for (const width of widths) expect(Array.from(line(stuck, width)).length).toBeLessThanOrEqual(width)
  })

  test("never passes its width, even with no room for the time", () => {
    expect(line(row({}), 39)).toBe("◆ implementor opus  Fix money parsing")
    expect(line(row({}), 36)).toBe("◆ implementor opus  Fix money parsi…")
    expect(line(row({}), 20)).toBe("◆ implementor opus")
    expect(Array.from(line(row({}), 10))).toHaveLength(10)
    expect(fit("abcdef", 3)).toBe("ab…")
    expect(fit("abc", 3)).toBe("abc")
  })

  test("a nested row is indented under its parent; a marking list marks the current row", () => {
    expect(line(row({ depth: 1 }), 80)).toStartWith("↳ ◆ implementor")
    expect(line(row({ depth: 2 }), 80)).toStartWith("  ↳ ◆ implementor")
    expect(line(row({}), 80, { mark: "marked" })).toStartWith("› ◆ implementor")
    expect(line(row({}), 80, { mark: "unmarked" })).toStartWith("  ◆ implementor")
  })
})

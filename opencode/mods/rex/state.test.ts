// OpenCode's state as a Rex program status record: the record of each state
// (working with its label or "thinking", blocked and on what, error, idle),
// its fields within the protocol's limits, a Rex pane told from the
// environment, and the write rule on a quick turn and a refused write. The
// model over sequences of session events is opencode/state.test.ts.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { APP, field, GAP_MS, inRex, type Report, reportOf, start, step, THINKING } from "./state.ts"

describe("the record of a state", () => {
  test("working: what runs, or thinking, under the root's title", () => {
    expect(reportOf({ state: "working", title: "Fix login", working: "shell: bun test", failed: false })).toEqual({
      state: "working",
      app: APP,
      title: "Fix login",
      message: "shell: bun test",
    })
    expect(reportOf({ state: "working", failed: true })).toEqual({ state: "working", app: APP, message: THINKING })
  })

  test("blocked: on what, and why", () => {
    expect(reportOf({ state: "blocked", message: "Permission: bash git push", blockedOn: "permission", failed: false })).toEqual({
      state: "blocked",
      app: APP,
      kind: "permission",
      message: "Permission: bash git push",
    })
    expect(reportOf({ state: "blocked", failed: false })).toEqual({ state: "blocked", app: APP, kind: "question" })
  })

  test("a failed last run is an error once idle; idle otherwise; no session is idle without a title", () => {
    expect(reportOf({ state: "idle", title: "Fix login", failed: true })).toEqual({ state: "error", app: APP, title: "Fix login", message: "The last run failed" })
    expect(reportOf({ state: "idle", title: "Fix login", failed: false })).toEqual({ state: "idle", app: APP, title: "Fix login" })
    expect(reportOf({ state: "unknown", failed: true })).toEqual({ state: "idle", app: APP })
  })

  test("fields are one line within the protocol's bytes, cut on a character", () => {
    expect(field(Option.some("a\nb\u0007\tc  "), 20)).toEqual(Option.some("a b c"))
    expect(field(Option.some(" \n"), 20)).toEqual(Option.none())
    expect(field(Option.none(), 20)).toEqual(Option.none())
    const cut = Option.getOrElse(field(Option.some("é".repeat(200)), 192), () => "")
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(192)
    expect(cut.endsWith("é…")).toBe(true)
    expect(reportOf({ state: "idle", title: "x".repeat(500), failed: false })).toEqual({ state: "idle", app: APP, title: `${"x".repeat(189)}…` })
  })

  test("a Rex pane is TERM_PROGRAM=rex or a REX_SESSION", () => {
    expect(inRex({ TERM_PROGRAM: "rex" })).toBe(true)
    expect(inRex({ REX_SESSION: "session:1" })).toBe(true)
    expect(inRex({ REX_SESSION: "", TERM_PROGRAM: "ghostty" })).toBe(false)
    expect(inRex({})).toBe(false)
  })
})

describe("when a record is written", () => {
  const working: Report = { state: "working", app: APP, message: THINKING }
  const idle: Report = { state: "idle", app: APP }

  test("a quick turn writes working, then the newest record at the gap's end; going back drops the held one", () => {
    const first = step(start(true), { type: "show", report: working, at: 1000 })
    expect(first.write).toEqual([working])
    const held = step(first.state, { type: "show", report: idle, at: 1100 })
    expect(held).toMatchObject({ write: [], wake: 1000 + GAP_MS })
    expect(step(held.state, { type: "tick", at: 1000 + GAP_MS }).write).toEqual([idle])
    const back = step(held.state, { type: "show", report: working, at: 1200 })
    expect(step(back.state, { type: "tick", at: 1000 + GAP_MS }).write).toEqual([])
  })

  test("a refused write is held and tried again at the gap's end", () => {
    const first = step(start(true), { type: "show", report: working, at: 1000 })
    const refused = step(first.state, { type: "refused", report: working, at: 1000 })
    expect(refused.wake).toBe(1000 + GAP_MS)
    expect(step(refused.state, { type: "tick", at: 1000 + GAP_MS }).write).toEqual([working])
  })

  test("exit clears once; nothing after it; outside Rex nothing at all", () => {
    const exited = step(step(start(true), { type: "show", report: idle, at: 0 }).state, { type: "exit" })
    expect(exited.write).toEqual([{ state: "clear" }])
    expect(step(exited.state, { type: "exit" }).write).toEqual([])
    expect(step(exited.state, { type: "show", report: working, at: 10_000 }).write).toEqual([])
    expect(step(start(false), { type: "show", report: idle, at: 0 }).write).toEqual([])
    expect(step(start(false), { type: "exit" }).write).toEqual([])
  })
})

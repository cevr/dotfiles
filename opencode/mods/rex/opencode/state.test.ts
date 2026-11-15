// The TUI's state for Rex: the record of each view (the family's state on the
// root, blocked on a permission or a question, error, idle); a model over
// seeded sequences of session events (in a Rex pane exit always clears and
// nothing follows it, outside one nothing is ever written, writes are changes
// spaced by the gap, and the last write before exit is the record of the last
// view); and the reporter over a stand-in claim and clock (outside Rex it
// never claims; in Rex it writes each change, holds one that comes too soon,
// tries a refused or throwing write again, and clears on exit and on
// disposal, once). Bun's tests resolve solid-js to its server build, which
// never re-runs a computation, so this file hands the reporter the reactive
// build OpenCode loads.
import { describe, expect, test } from "bun:test"
import type { SessionView, View } from "@dotfiles/opencode-herdr/activity"
import { noView } from "@dotfiles/opencode-herdr/opencode/view"
import { Equal, Option, Result } from "effect"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js/dist/solid.js"
import { APP, type Event, GAP_MS, type Report, reportOf, type Reporting, type Seen, start, step, THINKING } from "../state.ts"
import { type Claim, type Clock, reportState, seenOf } from "./state.ts"

const member = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  running: false,
  queued: false,
  permissions: [],
  questions: [],
  asked: [],
  tools: [],
  ...over,
})

const viewOf = (root: SessionView, ...descendants: ReadonlyArray<SessionView>): View => ({ root, descendants })
const recordOf = (view: View, failed = false) => reportOf(seenOf(view, failed))

describe("the record of a view", () => {
  test("a running call is the working label, under the root's title; running with no call is thinking", () => {
    const view = viewOf(member("ses_1", { title: "Fix login", running: true, tools: [{ tool: "bash", input: { command: "bun test" }, at: 1 }] }))
    expect(recordOf(view)).toEqual({ state: "working", app: APP, title: "Fix login", message: "shell: bun test" })
    expect(recordOf(viewOf(member("ses_1", { running: true })))).toEqual({ state: "working", app: APP, message: THINKING })
  })

  test("the family on the root: a busy subagent makes it working, a blocked one blocked", () => {
    const busy = viewOf(member("ses_1", { title: "Root" }), member("ses_2", { running: true }), member("ses_3"))
    expect(recordOf(busy)).toEqual({ state: "working", app: APP, title: "Root", message: "1 subagent" })
    const blocked = viewOf(member("ses_1", { title: "Root", running: true }), member("ses_2", { running: true, permissions: ["bash rm -rf build"] }))
    expect(recordOf(blocked)).toEqual({ state: "blocked", app: APP, kind: "permission", title: "Root", message: "Permission: bash rm -rf build" })
  })

  test("a question form, and the owner's background questions once nothing works, block as questions", () => {
    expect(recordOf(viewOf(member("ses_1", { running: true, questions: ["Which branch?"] })))).toEqual({
      state: "blocked",
      app: APP,
      kind: "question",
      message: "Question: Which branch?",
    })
    const asked = [{ label: "Export the CSV", at: 2 }]
    expect(recordOf(viewOf(member("ses_1", { asked })))).toEqual({ state: "blocked", app: APP, kind: "question", message: "Question: Export the CSV" })
    expect(recordOf(viewOf(member("ses_1", { running: true, asked }))).state).toBe("working")
  })

  test("a failed last run is an error once nothing works or waits; no session is idle", () => {
    const view = viewOf(member("ses_1", { title: "Fix login" }))
    expect(recordOf(view, true)).toEqual({ state: "error", app: APP, title: "Fix login", message: "The last run failed" })
    expect(recordOf(viewOf(member("ses_1", { running: true })), true).state).toBe("working")
    expect(recordOf(noView)).toEqual({ state: "idle", app: APP })
  })
})

/** A seeded draw in [0, 1), so a failing case names its seed. */
const drawsOf = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (draw: () => number): SessionEvent => EVENTS[Math.floor(draw() * EVENTS.length)] ?? "run"

/** The session events a turn is made of, as the TUI's data would change. */
type SessionEvent = "run" | "call" | "settle" | "finish" | "fail" | "permission" | "allow" | "ask" | "answer" | "spawn" | "subagent done" | "rename"
const EVENTS: ReadonlyArray<SessionEvent> = ["run", "call", "settle", "finish", "fail", "permission", "allow", "ask", "answer", "spawn", "subagent done", "rename"]

interface World {
  readonly root: SessionView
  readonly subagents: ReadonlyArray<SessionView>
  readonly failed: boolean
}

const happen = (world: World, event: SessionEvent, at: number): World => {
  const root = world.root
  if (event === "run") return { ...world, root: { ...root, running: true }, failed: false }
  if (event === "call") return { ...world, root: { ...root, tools: [{ tool: "bash", input: { command: `step ${at}` }, at }] } }
  if (event === "settle") return { ...world, root: { ...root, tools: [] } }
  if (event === "finish") return { ...world, root: { ...root, running: false, tools: [] } }
  if (event === "fail") return { ...world, root: { ...root, running: false, tools: [] }, failed: true }
  if (event === "permission") return { ...world, root: { ...root, permissions: ["bash git push"] } }
  if (event === "allow") return { ...world, root: { ...root, permissions: [] } }
  if (event === "ask") return { ...world, root: { ...root, asked: [{ label: "Pick a name", at }] } }
  if (event === "answer") return { ...world, root: { ...root, asked: [] } }
  if (event === "spawn") return { ...world, subagents: [...world.subagents, member(`ses_sub${at}`, { running: true })] }
  if (event === "subagent done") return { ...world, subagents: world.subagents.slice(1) }
  return { ...world, root: { ...root, title: `Title ${at}` } }
}

/** What the terminal received, and when. */
interface Written {
  readonly report: Report
  readonly at: number
}

/**
 * Runs a seeded sequence of session events through the write rule, in a Rex
 * pane or not, firing each wake it asks for when its time comes, then (when
 * `exit`) the exit and a later view. Returns what was written and the last
 * view's record before exit.
 */
const run = (seed: number, rex: boolean, exit: boolean) => {
  const draw = drawsOf(seed)
  let world: World = { root: member("ses_root"), subagents: [], failed: false }
  let state: Reporting = start(rex)
  let wake: Option.Option<number> = Option.none()
  const written: Array<Written> = []
  const feed = (event: Event, at: number) => {
    const next = step(state, event)
    state = next.state
    for (const report of next.write) written.push({ report, at })
    wake = Option.orElse(Option.fromUndefinedOr(next.wake), () => wake)
  }
  const until = (at: number) => {
    for (let due = Option.filter(wake, (time) => time <= at); Option.isSome(due); due = Option.filter(wake, (time) => time <= at)) {
      wake = Option.none()
      feed({ type: "tick", at: due.value }, due.value)
    }
  }
  const seen = () => recordOf(viewOf(world.root, ...world.subagents), world.failed)
  let at = 0
  feed({ type: "show", report: seen(), at }, at)
  const count = 1 + Math.floor(draw() * 40)
  for (let index = 0; index < count; index++) {
    at += Math.floor(draw() * 600)
    until(at)
    world = happen(world, pick(draw), at)
    feed({ type: "show", report: seen(), at }, at)
  }
  until(Number.POSITIVE_INFINITY)
  const last = seen()
  if (!exit) return { written, last }
  feed({ type: "exit" }, at)
  world = happen(world, "run", at + 10_000)
  feed({ type: "show", report: seen(), at: at + 10_000 }, at + 10_000)
  until(Number.POSITIVE_INFINITY)
  return { written, last }
}

describe("when records are written, over sequences of session events", () => {
  test("in a Rex pane exit always clears, once, and nothing is written after it", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { written } = run(seed, true, true)
      const clears = written.filter((entry) => entry.report.state === "clear")
      expect({ seed, last: written.at(-1)?.report, clears: clears.length }).toEqual({ seed, last: { state: "clear" }, clears: 1 })
    }
  })

  test("outside a Rex pane nothing is ever written, exit included", () => {
    for (let seed = 1; seed <= 300; seed++) expect({ seed, written: run(seed, false, true).written }).toEqual({ seed, written: [] })
  })

  test("writes are changes, spaced by the gap, and the last before exit is the last view's record", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { written, last } = run(seed, true, false)
      for (let index = 1; index < written.length; index++) {
        const [before, after] = [written[index - 1], written[index]]
        expect({ seed, index, changed: !Equal.equals(before?.report, after?.report) }).toEqual({ seed, index, changed: true })
        expect({ seed, index, spaced: (after?.at ?? 0) - (before?.at ?? 0) >= GAP_MS }).toEqual({ seed, index, spaced: true })
      }
      expect({ seed, last: written.at(-1)?.report }).toEqual({ seed, last })
    }
  })
})

/** A clock the test moves by hand: `advance` runs each timer that falls due. */
const manualClock = () => {
  let now = 0
  let timers: Array<{ readonly at: number; readonly run: () => void }> = []
  const clock: Clock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run }
      timers.push(timer)
      return () => {
        timers = timers.filter((entry) => entry !== timer)
      }
    },
  }
  const advance = (ms: number) => {
    now += ms
    const due = timers.filter((timer) => timer.at <= now)
    timers = timers.filter((timer) => timer.at > now)
    for (const timer of due) timer.run()
  }
  return { clock, advance }
}

const seenAt = (running: boolean): Seen => seenOf(viewOf(member("ses_1", { title: "Fix login", running })), false)
const working: Report = { state: "working", app: APP, title: "Fix login", message: THINKING }
const idle: Report = { state: "idle", app: APP, title: "Fix login" }

/** A reporter over a claim that records each report, refusing (or throwing on) them while `refuse` says so. */
const setup = (rex: boolean, refuse: () => boolean | "throw" = () => false) => {
  const { clock, advance } = manualClock()
  const reports: Array<Report> = []
  let claims = 0
  const claim = (): Claim => {
    claims++
    return {
      report: (report) => {
        const refused = refuse()
        // The renderer throws on a report the protocol refuses.
        if (refused === "throw") return Result.getOrThrow(Result.fail("invalid report"))
        if (refused) return false
        reports.push(report)
        return true
      },
    }
  }
  return createRoot((dispose) => {
    const [seen, setSeen] = createSignal<Seen>(seenAt(false))
    const reporter = reportState({ rex, claim, seen, clock, solid: { createEffect, onCleanup } })
    return { reports, claims: () => claims, set: (running: boolean) => setSeen(seenAt(running)), reporter, advance, dispose }
  })
}

describe("the TUI's state reporter", () => {
  test("outside Rex it claims nothing and writes nothing", () => {
    const bench = setup(false)
    bench.set(true)
    bench.reporter.exit()
    bench.dispose()
    expect({ claims: bench.claims(), reports: bench.reports }).toEqual({ claims: 0, reports: [] })
  })

  test("a turn: idle, working, and idle again at the gap's end; exit clears once, disposal adds nothing", () => {
    const bench = setup(true)
    expect(bench.claims()).toBe(1)
    expect(bench.reports).toEqual([idle])
    bench.advance(GAP_MS)
    bench.set(true)
    expect(bench.reports).toEqual([idle, working])
    bench.advance(10)
    bench.set(false)
    expect(bench.reports).toEqual([idle, working])
    bench.advance(GAP_MS)
    expect(bench.reports).toEqual([idle, working, idle])
    bench.reporter.exit()
    bench.set(true)
    bench.dispose()
    expect(bench.reports).toEqual([idle, working, idle, { state: "clear" }])
  })

  test("a refused or throwing write is tried again at the next tick", () => {
    let refusing: boolean | "throw" = true
    const bench = setup(true, () => refusing)
    expect(bench.reports).toEqual([])
    refusing = "throw"
    bench.advance(GAP_MS)
    expect(bench.reports).toEqual([])
    refusing = false
    bench.advance(GAP_MS)
    expect(bench.reports).toEqual([idle])
    bench.dispose()
    expect(bench.reports).toEqual([idle, { state: "clear" }])
  })
})

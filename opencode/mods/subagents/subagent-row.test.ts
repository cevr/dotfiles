// Who works on what, how it stands, what it says, and which rows show.
import { describe, expect, test } from "bun:test"
import type { Call, Message, Part, Session } from "./family.ts"
import { columns, format } from "./line.ts"
import { latchUpdate, LINGER_MS, rows, subagents, visible, type Row } from "./subagent-row.ts"

const call = (tool: string, input: Record<string, unknown>, over: Partial<Call> = {}): Call => ({
  type: "call",
  tool,
  status: "completed",
  input,
  metadata: {},
  completed: 5,
  ...over,
})
const words = (text: string): Part => ({ type: "words", text })
const step = (parts: ReadonlyArray<Part>, agent = "worker"): Message => ({ type: "assistant", agent, parts })
const launch = (child: string, input: Record<string, unknown>) =>
  call("subagent", { background: true, ...input }, { metadata: { sessionID: child, status: "running" } })
const notice = (child: string, state: string, at: number, text = ""): Message => ({ type: "notice", childID: child, state, at, text })
const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  time: { created: 0 },
  running: false,
  shells: [],
  permissions: [],
  questions: [],
  messages: [],
  ...over,
})
const family = (...sessions: Session[]) => ({ root: "root", sessions })

describe("a row's role, unit and order", () => {
  test("one row per subagent, depth first in launch order, with the child's agent and the call's description", () => {
    const world = family(
      session("root", { messages: [step([launch("i", { description: "Fix money parsing" }), launch("v", { description: "Check CSV quoting" })])] }),
      session("v", { parentID: "root", agent: "verifier", title: "verifier title", time: { created: 20 }, running: true }),
      session("i", { parentID: "root", agent: "implementor", title: "Fix money parsing", time: { created: 10 }, running: true }),
      session("i1", { parentID: "i", agent: "worker", title: "Read the parser", time: { created: 15 }, running: true }),
    )
    expect(subagents(world, "root").map((row) => [row.id, row.depth, row.role, row.tone, row.unit])).toEqual([
      ["i", 0, "implementor", "implementor", "Fix money parsing"],
      ["i1", 1, "worker", "worker", "Read the parser"],
      ["v", 0, "verifier", "verifier", "Check CSV quoting"],
    ])
  })

  test("a reused child shows the description of its newest call", () => {
    const world = family(
      session("root", {
        messages: [
          step([launch("i", { description: "implementor run-state r1" })]),
          step([launch("i", { description: "implementor run-state r3" })]),
        ],
      }),
      session("i", { parentID: "root", agent: "implementor", title: "implementor run-state r3", time: { created: 1 }, running: true }),
    )
    expect(subagents(world, "root").map((row) => row.unit)).toEqual(["run-state r3"])
  })

  test("the role falls back to the child's own steps, then the call's agent; other agents tone as other", () => {
    const world = family(
      session("root", { messages: [step([launch("b", { agent: "planner", description: "Plan it" })])] }),
      session("a", { parentID: "root", time: { created: 1 }, messages: [step([words("hi")], "general")] }),
      session("b", { parentID: "root", time: { created: 2 } }),
      session("c", { parentID: "root", agent: "code-reviewer", time: { created: 3 } }),
    )
    expect(subagents(world, "root").map((row) => [row.role, row.tone, row.unit])).toEqual([
      ["general", "general", "subagent"],
      ["planner", "planner", "Plan it"],
      ["code-reviewer", "other", "subagent"],
    ])
  })

  test("a worker or general child whose description names an orchestrate step reads as that role, the role word out of its unit", () => {
    const children = [
      ["a", "worker", "pkg-lower implementor"],
      ["b", "worker", "closure-flake verifier r1 (Opus)"],
      ["c", "general", "planner hsdaily r1"],
      ["d", "implementor", "implementor hsdaily r2"],
      ["e", "worker", "Fix the verifier's timeout"],
      ["f", "worker", "Fix money parsing"],
      ["g", "verifier", "implementor pkg-lower r1"],
      ["h", "explore", "verifier pkg-lower r1"],
    ] as const
    const world = family(
      session("root", { messages: [step(children.map(([id, , description]) => launch(id, { agent: "general", description })))] }),
      ...children.map(([id, agent], index) => session(id, { parentID: "root", agent, time: { created: index } })),
    )
    expect(subagents(world, "root").map((row) => [row.role, row.tone, row.unit])).toEqual([
      ["implementor", "implementor", "pkg-lower"],
      ["verifier", "verifier", "closure-flake r1 (Opus)"],
      ["planner", "planner", "hsdaily r1"],
      ["implementor", "implementor", "hsdaily r2"],
      ["worker", "worker", "Fix the verifier's timeout"],
      ["worker", "worker", "Fix money parsing"],
      ["verifier", "verifier", "implementor pkg-lower r1"],
      ["explore", "other", "verifier pkg-lower r1"],
    ])
  })

  test("the workbox's worker lanes draw as the steps they run (ergo's dock)", () => {
    const lanes = [
      ["p", "pkg-lower implementor"],
      ["c", "closure-flake verifier r1 (Opus)"],
      ["g", "gate-test-disk verifier r1 (Opus)"],
    ] as const
    const world = family(
      session("root", { messages: [step(lanes.map(([id, description]) => launch(id, { agent: "general", description })))] }),
      ...lanes.map(([id], index) =>
        session(id, { parentID: "root", agent: "worker", model: "claude-opus-5-5", time: { created: index, busy: 0 }, running: true }),
      ),
    )
    const shown = rows(world, "root", 0)
    const cols = columns(shown)
    expect(shown.map((row) => format(row, 80, { columns: cols, spinner: "◆" }).map((segment) => segment.text).join(""))).toEqual([
      "◆ implementor opus 5.5  pkg-lower                 starting · 0s",
      "◆ verifier    opus 5.5  closure-flake r1 (Opus)   starting · 0s",
      "◆ verifier    opus 5.5  gate-test-disk r1 (Opus)  starting · 0s",
    ])
  })

  test("the model reads by its short name, apart from its version; none when the session does not say", () => {
    const world = family(
      session("root"),
      session("a", { parentID: "root", model: "claude-opus-5-5", time: { created: 1 } }),
      session("b", { parentID: "root", time: { created: 2 } }),
    )
    expect(subagents(world, "root").map((row) => row.model)).toEqual([{ name: "opus", version: "5.5" }, undefined])
  })

  test("a cycle in the parents never loops", () => {
    const world = family(session("a", { parentID: "b" }), session("b", { parentID: "a" }))
    expect(subagents(world, "a").map((row) => row.id)).toEqual(["b"])
  })
})

describe("a row's state", () => {
  const one = (child: Partial<Session> = {}, root: Partial<Session> = {}) =>
    subagents(family(session("root", root), session("a", { parentID: "root", agent: "worker", time: { created: 1, busy: 100 }, ...child })), "root")[0]

  test("works while the host runs its turn, from when it went busy", () => {
    expect(one({ running: true })).toMatchObject({ state: "working", since: 100 })
  })

  test("waits while its turn runs a call that only waits, from when that call started", () => {
    const loop = call("bash", { command: "for i in 1 2 3; do [ -s $D/gate.log ] && break; sleep 30; done" }, { status: "running", started: 400 })
    expect(one({ running: true, messages: [step([words("Wait for the gate.")]), step([loop])] })).toMatchObject({
      state: "waiting",
      update: "polling gate.log",
      since: 400,
    })
    const described = call("bash", { command: "gh run watch 1", description: "Wait for CI" }, { status: "running", started: 400 })
    expect(one({ running: true, messages: [step([described])] })).toMatchObject({ state: "waiting", update: "Wait for CI" })
  })

  test("works again once the wait ends, timed from its end", () => {
    const loop = call("bash", { command: "sleep 30" }, { started: 400, completed: 700 })
    expect(one({ running: true, messages: [step([loop]), step([call("bash", { command: "bun test" }, { status: "running", started: 710 })])] })).toMatchObject({
      state: "working",
      update: "running bun test",
      since: 700,
    })
  })

  test("carries when it was last heard from, for the row's stale update", () => {
    const quiet = one({ running: true, messages: [step([{ type: "words", text: "Running the gate.", at: 150 }, call("bash", { command: "bun run gate" }, { status: "running", started: 160 })])] })
    expect(quiet).toMatchObject({ state: "working", since: 100, heard: 160 })
    expect(visible(quiet ? [quiet] : [], 2_000).map((row) => [row.elapsed, row.quiet])).toEqual([[1_900, 1_840]])
  })

  test("is blocked on a permission or a question, even while running", () => {
    expect(one({ running: true, permissions: ["shell rm -rf out"] })).toMatchObject({
      state: "blocked",
      update: "permission: shell rm -rf out",
    })
    expect(one({ questions: ["Which file?"] })).toMatchObject({ state: "blocked", update: "question: Which file?" })
  })

  test("a background notice can explain a row but does not give it an end", () => {
    const parent = (state: string, text = "") => ({ messages: [step([launch("a", {})]), notice("a", state, 500, text)] })
    const reported = one({ messages: [step([]), step([])] }, parent("completed"))
    expect(reported).toMatchObject({ state: "idle", update: "", heard: 500 })
    expect(reported).not.toHaveProperty("ended")
    expect(
      one({}, parent("error", '<background-result kind="subagent" sessionID="a" state="error" description="x">\nRate limited. Try later.\n</background-result>')),
    ).toMatchObject({ state: "idle", update: "Rate limited.", heard: 500 })
    // A stored session keeps the fork's notices from before upstream e51247f626.
    expect(one({}, parent("error", '<subagent state="error">\nRate limited. Try later.\n</subagent>'))).toMatchObject({
      state: "idle",
      update: "Rate limited.",
      heard: 500,
    })
    expect(one({}, parent("cancelled"))).toMatchObject({ state: "idle", update: "" })
  })

  test("a foreground reply can explain a row but cannot settle a child", () => {
    const foreground = (over: Partial<Call>) => ({ messages: [step([call("subagent", { description: "x" }, { metadata: { sessionID: "a" }, ...over })])] })
    expect(one({}, foreground({}))).toMatchObject({ state: "idle" })
    expect(one({}, foreground({ status: "error", error: "Subagent failed (sessionID: a): boom" }))).toMatchObject({
      state: "idle",
      update: "boom",
    })
    expect(one({}, foreground({ status: "error", error: "Subagent cancelled (sessionID: a)" }))).toMatchObject({ state: "idle" })
  })

  test("with neither, the session's outcome; with nothing at all, idle", () => {
    expect(one({ outcome: "succeeded", time: { created: 1, idle: 900 } })).toMatchObject({ state: "done", ended: 900 })
    expect(one({ outcome: "failed" })).toMatchObject({ state: "failed", update: "" })
    expect(one({ outcome: "interrupted" })).toMatchObject({ state: "cancelled" })
    expect(one()).toMatchObject({ state: "idle", update: "" })
  })

  test("the update follows a worker from thinking to a shell command", () => {
    expect(one({ running: true, messages: [step([words("Check the parser first. Then the tests.")])] })).toMatchObject({
      update: "Check the parser first.",
    })
    expect(
      one({ running: true, messages: [step([words("Check the parser first.")]), step([call("bash", { command: "bun test money" }, { status: "running" })])] }),
    ).toMatchObject({ update: "running bun test money" })
  })
})

describe("a latched subagent", () => {
  // 13:00 UTC on Wednesday 4 November 2026; the pace opens at 14:30.
  const AT = Date.parse("2026-11-04T13:00:00Z")
  const pace = { hold: "pace", reason: "anthropic's 5h window is at 92% used of 100%", opensAt: Date.parse("2026-11-04T14:30:00Z"), at: AT }
  const latched = (latch: Session["latch"], over: Partial<Session> = {}, root: Partial<Session> = {}) =>
    subagents(
      family(
        session("root", root),
        session("a", { parentID: "root", agent: "verifier", title: "Check the export", time: { created: AT, updated: AT + 5 }, ...(latch ? { latch } : {}), ...over }),
      ),
      "root",
      { timeZone: "UTC" },
    )[0]
  const answered = call("subagent", { agent: "verifier", description: "Check the export" }, { metadata: { sessionID: "a", status: "latched" } })

  test("waits latched from when it latched, saying what holds it and when it opens; it counts as live", () => {
    expect(latched(pace)).toMatchObject({ role: "verifier", unit: "Check the export", state: "latched", update: "pace · opens 14:30", since: AT })
    expect(visible([latched(pace)!], AT + 130_000).map((row) => [row.state, row.elapsed])).toEqual([["latched", 130_000]])
    // The parent's call answered at once: it does not keep the row waiting, and its description names the unit.
    expect(latched(pace, { title: "other" }, { messages: [step([answered])] })).toMatchObject({ state: "latched", unit: "Check the export" })
  })

  test("the Sabbath's opening names its day when it is not the day it latched", () => {
    const sabbath = { hold: "sabbath", reason: "It is the Sabbath.", opensAt: Date.parse("2026-11-07T22:12:00Z"), at: Date.parse("2026-11-06T23:00:00Z") }
    expect(latchUpdate(sabbath, "UTC")).toBe("Sabbath · opens Sat 22:12")
    expect(latchUpdate(sabbath, "America/Toronto")).toBe("Sabbath · opens Sat 17:12")
    expect(latchUpdate(pace, "UTC")).toBe("pace · opens 14:30")
  })

  test("a cancelled latch reads cancelled and a failed one failed, then they linger and go like other stopped rows", () => {
    const cancelled = latched({ ...pace, cancelledAt: AT + 60_000 })
    expect(cancelled).toMatchObject({ state: "cancelled", update: "", ended: AT + 60_000 })
    expect(visible([cancelled!], AT + 60_000 + LINGER_MS).map((row) => row.id)).toEqual([])
    expect(latched({ ...pace, failed: "the subagent tool is not loaded. More." })).toMatchObject({
      state: "failed",
      update: "the subagent tool is not loaded.",
      ended: AT + 5,
    })
  })

  test("once a latch opens its session says when it ends, independently of notice delivery", () => {
    expect(latched(pace, { running: true, time: { created: AT, busy: AT + 10 } })).toMatchObject({ state: "working", since: AT + 10 })
    // Once it stopped with nothing of its own running, the parent's call with no stop notice yet keeps nothing live.
    expect(latched(pace, { time: { created: AT, busy: AT + 10, idle: AT + 20 }, outcome: "succeeded" }, { messages: [step([answered])] })).toMatchObject({
      state: "done",
      ended: AT + 20,
    })
    expect(
      latched(pace, { time: { created: AT, busy: AT + 10, idle: AT + 20 }, outcome: "succeeded" }, { messages: [step([answered]), notice("a", "completed", AT + 21)] }),
    ).toMatchObject({ state: "done", ended: AT + 20 })
  })
})

describe("which rows show", () => {
  const row = (over: Partial<Row>): Row => ({
    id: "a",
    depth: 0,
    role: "worker",
    tone: "worker",
    unit: "u",
    state: "working",
    update: "",
    since: 0,
    ...over,
  })
  const all = [
    row({ id: "run", since: 400 }),
    row({ id: "wait", state: "waiting", heard: 10 }),
    row({ id: "ask", state: "blocked" }),
    row({ id: "fresh", state: "done", ended: 1_000, since: undefined }),
    row({ id: "old", state: "done", ended: 0, since: undefined }),
    row({ id: "unknown", state: "idle", since: undefined }),
  ]

  test("working, waiting and blocked always, with their time in that state and since last heard from; a stopped one lingers, then drops; one with no end time never shows", () => {
    const now = 1_000 + LINGER_MS - 1
    expect(visible(all, now).map((value) => [value.id, value.elapsed, value.quiet])).toEqual([
      ["run", now - 400, undefined],
      ["wait", now, now - 10],
      ["ask", now, undefined],
      ["fresh", undefined, undefined],
    ])
    expect(visible(all, 1_000 + LINGER_MS).map((value) => value.id)).toEqual(["run", "wait", "ask"])
    expect(visible(all, 1_500, { linger: 100 }).map((value) => value.id)).toEqual(["run", "wait", "ask"])
  })

  test("the current session always shows", () => {
    expect(visible(all, 99_999, { current: "old" }).map((value) => value.id)).toEqual(["run", "wait", "ask", "old"])
  })

  test("an owner read can display Checking, but its Unknown answer leaves the strip without a linger or live clock", () => {
    const view = { revision: 2, at: 100, sinceReload: false, waitingOn: "" as const, diagnostic: false }
    const child = session("child", { parentID: "root", lifecycle: { ...view, kind: "checking" } })
    expect(rows(family(child), "root", 100)).toMatchObject([{ state: "checking" }])
    const uncertain = session("child", { ...child, lifecycle: { ...view, kind: "unknown" } })
    expect(rows(family(uncertain), "root", 101)).toEqual([])
    expect(rows(family(uncertain), "root", 101, { current: "child" })).toMatchObject([{ state: "unknown", update: "Current execution not known" }])
  })

  test("rows reads the family and keeps the ones worth showing", () => {
    const world = family(
      session("root", { messages: [notice("b", "completed", 10)] }),
      session("a", { parentID: "root", time: { created: 1 }, running: true }),
      session("b", { parentID: "root", time: { created: 2 } }),
    )
    expect(rows(world, "root", 20).map((value) => [value.id, value.state, value.elapsed])).toEqual([
      ["a", "working", 19],
      ["b", "idle", undefined],
    ])
    expect(rows(world, "root", 10 + LINGER_MS).map((value) => value.id)).toEqual(["a"])
  })
})

describe("a subagent waiting on its own background work", () => {
  const one = (child: Partial<Session> = {}, root: Partial<Session> = {}, more: ReadonlyArray<Session> = []) =>
    subagents(family(session("root", root), session("a", { parentID: "root", agent: "worker", time: { created: 1, busy: 100 }, ...child }), ...more), "root")[0]
  const backgrounded = (command: string, shellID: string) =>
    call("shell", { command, background: true }, { metadata: { status: "running", shellID } })
  const shellNotice = (shellID: string, at: number): Message => ({ type: "shell", shellID, state: "completed", at })
  const kernel = (...calls: ReadonlyArray<Call>) => call("kernel", { code: "// run it" }, { calls })
  const runs = (...ids: ReadonlyArray<string>) => ({ shells: ids.map((id) => ({ id, command: "sleep 999" })) })

  test("a background shell the host's registry lists as running keeps it waiting from when its turn ended, even after that turn succeeded", () => {
    const waiting = one({ outcome: "succeeded", time: { created: 1, busy: 100, idle: 200 }, messages: [step([backgrounded("sleep 2 && echo ok", "sh_1")])], ...runs("sh_1") })
    expect(waiting).toMatchObject({ state: "waiting", update: "sleep 2", since: 200 })
    expect(waiting).not.toHaveProperty("ended")
    expect(visible(waiting ? [waiting] : [], 1_000).map((row) => row.elapsed)).toEqual([800])
  })

  test("a background shell the registry no longer lists has ended, with no stop notice: the row ends as its session did", () => {
    // Killed by PID or through its handle, or lost to a restart: no notice ever comes.
    const killed = one({ outcome: "succeeded", time: { created: 1, busy: 100, idle: 200 }, messages: [step([backgrounded("sleep 999", "sh_1")])] })
    expect(killed).toMatchObject({ state: "done", ended: 200, update: "1 step" })
    expect(visible(killed ? [killed] : [], 200 + LINGER_MS)).toEqual([])
    // A shell of another session's keeps nothing of this one live.
    expect(one({ outcome: "succeeded", messages: [step([backgrounded("sleep 999", "sh_1")])] }, runs("sh_1"))).toMatchObject({ state: "done" })
  })

  test("it says what it waits on by the shell call's description, else in a few words; a sentence written after starting it wins", () => {
    const gate = (over: Record<string, unknown> = {}) =>
      call("shell", { command: "cd /w && flock /home/x/gate.lock ./scripts/gate.sh", background: true, ...over }, { metadata: { shellID: "sh_9" } })
    const running = runs("sh_9")
    expect(one({ messages: [step([gate()])], ...running })).toMatchObject({ update: "flock gate.lock ./scripts/gate.sh" })
    expect(one({ messages: [step([gate({ description: "Run the gate under the lock" })])], ...running })).toMatchObject({ update: "Run the gate under the lock" })
    expect(
      one({ messages: [step([words("Start the gate.")]), step([gate()]), step([words("Queued behind the shared gate lock. Back when it runs.")])], ...running }),
    ).toMatchObject({ update: "Queued behind the shared gate lock." })
    expect(one({ messages: [step([words("Start the gate.")]), step([gate()])], ...running })).toMatchObject({ update: "flock gate.lock ./scripts/gate.sh" })
  })

  test("a running shell no call names reads by the registry's own words", () => {
    expect(one({ shells: [{ id: "sh_7", command: "cd /w && bun run gate", description: "Run the gate" }] })).toMatchObject({ state: "waiting", update: "Run the gate" })
    expect(one({ shells: [{ id: "sh_7", command: "cd /w && bun run gate" }] })).toMatchObject({ state: "waiting", update: "bun run gate" })
  })

  test("its shell's stop notice and the registry agree: then it ends as before", () => {
    expect(
      one({ outcome: "succeeded", time: { created: 1, idle: 900 }, messages: [step([backgrounded("sleep 2", "sh_1")]), shellNotice("sh_1", 800), step([words("Done.")])] }),
    ).toMatchObject({ state: "done", ended: 900 })
  })

  test("a shell a kernel cell moved to the background counts the same, by the record's shell ID", () => {
    const cell = step([kernel(call("shell", { command: "bun test" }, { metadata: { shellID: "sh_2" } }))])
    expect(one({ messages: [cell], ...runs("sh_2") })).toMatchObject({ state: "waiting", update: "bun test" })
    expect(one({ outcome: "succeeded", messages: [cell] })).toMatchObject({ state: "done" })
  })

  test("its own subagent that works keeps it waiting, recursively; several waits read as the first and a count", () => {
    const messages = [step([launch("g", { description: "Check the parser" }), backgrounded("bun test", "sh_5")])]
    const grandchild = (over: Partial<Session> = {}) => session("g", { parentID: "a", agent: "worker", title: "g title", time: { created: 2 }, ...over })
    expect(one({ messages, ...runs("sh_5") }, {}, [grandchild({ running: true })])).toMatchObject({ state: "waiting", update: "Check the parser +1" })
    // Its grandchild itself waits on a running shell of its own: still work, so the child waits.
    expect(one({ messages }, {}, [grandchild(runs("sh_8"))])).toMatchObject({ state: "waiting", update: "Check the parser" })
    // A stopped grandchild with no notice, and no shell running: nothing waits.
    expect(one({ outcome: "succeeded", messages }, {}, [grandchild({ outcome: "succeeded" })])).toMatchObject({ state: "done" })
  })

  test("the parent's call with no stop notice keeps nothing live: a stopped child ends as its session did", () => {
    const foreground = { messages: [step([call("subagent", { description: "x" }, { status: "running", metadata: { sessionID: "a" } })])] }
    expect(one({ outcome: "succeeded", time: { created: 1, idle: 40 } }, foreground)).toMatchObject({ state: "done", ended: 40 })
    expect(one({ outcome: "succeeded", time: { created: 1, idle: 40 }, messages: [step([words("Done. All green.")])] }, { messages: [step([launch("a", {})])] })).toMatchObject({
      state: "done",
      ended: 40,
    })
    const noTime = one({ outcome: "succeeded" }, { messages: [step([launch("a", {})]), notice("a", "completed", 50)] })
    expect(noTime).toMatchObject({ state: "done" })
    expect(noTime).not.toHaveProperty("ended")
  })

  test("an error notice while a shell is live, a lagging snapshot, and a fresh success are different", () => {
    const root = { messages: [notice("a", "error", 500, "Fixture step error")] }
    const failure = { outcome: "failed", time: { created: 1, busy: 100, idle: 300 }, messages: [step([{ ...backgrounded("fixture", "sh_1"), completed: 120 }])] }
    expect(one({ ...failure, ...runs("sh_1") }, root)).toMatchObject({ state: "waiting", update: "Step ended in error; work continues: fixture" })
    const pending = one({ ...failure, wakePending: true }, root)
    expect(visible([pending], 301)).toMatchObject([{ state: "waiting", update: "Step ended in error; work continues: awaiting host wake" }])
    const unresolved = one({ ...failure, execution: { kind: "undetermined", at: 305 } }, root)
    expect(visible([unresolved], 1_000_000)).toMatchObject([{
      state: "waiting", since: 305, update: "Undetermined: a step failed; its background command ended; the host does not say whether a result is still to be delivered",
    }])
    expect(visible([one(failure, root)], 301)).toMatchObject([{ state: "failed", ended: 300 }])
    expect(one({ ...failure, running: true }, root)).toMatchObject({ state: "working" })
    expect(one({ outcome: "succeeded", time: { created: 1, busy: 501, idle: 530 } }, root)).toMatchObject({ state: "done", ended: 530 })
  })
})

// Who works on what, how it stands, what it says, and which rows show.
import { describe, expect, test } from "bun:test"
import type { Call, Message, Part, Session } from "./family.ts"
import { LINGER_MS, rows, subagents, visible, type Row } from "./subagent-row.ts"

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

  test("a cycle in the parents never loops", () => {
    const world = family(session("a", { parentID: "b" }), session("b", { parentID: "a" }))
    expect(subagents(world, "a").map((row) => row.id)).toEqual(["b"])
  })
})

describe("a row's state", () => {
  const one = (child: Partial<Session> = {}, root: Partial<Session> = {}) =>
    subagents(family(session("root", root), session("a", { parentID: "root", agent: "worker", time: { created: 1, busy: 100 }, ...child })), "root")[0]

  test("runs while the host says so, from when it went busy", () => {
    expect(one({ running: true })).toMatchObject({ state: "running", since: 100 })
  })

  test("is blocked on a permission or a question, even while running", () => {
    expect(one({ running: true, permissions: ["shell rm -rf out"] })).toMatchObject({
      state: "blocked",
      update: "waiting on permission: shell rm -rf out",
    })
    expect(one({ questions: ["Which file?"] })).toMatchObject({ state: "blocked", update: "waiting on question: Which file?" })
  })

  test("a background one ends as its stop notice says, at the notice's time", () => {
    const parent = (state: string, text = "") => ({ messages: [step([launch("a", {})]), notice("a", state, 500, text)] })
    expect(one({ messages: [step([]), step([])] }, parent("completed"))).toMatchObject({ state: "done", update: "done · 2 steps", ended: 500 })
    expect(one({}, parent("error", '<subagent state="error">\nRate limited. Try later.\n</subagent>'))).toMatchObject({
      state: "failed",
      update: "failed · Rate limited.",
      ended: 500,
    })
    expect(one({}, parent("cancelled"))).toMatchObject({ state: "cancelled", update: "cancelled" })
  })

  test("a foreground one ends as its call did", () => {
    const foreground = (over: Partial<Call>) => ({ messages: [step([call("subagent", { description: "x" }, { metadata: { sessionID: "a" }, ...over })])] })
    expect(one({}, foreground({}))).toMatchObject({ state: "done", ended: 5 })
    expect(one({}, foreground({ status: "error", error: "Subagent failed (sessionID: a): boom" }))).toMatchObject({
      state: "failed",
      update: "failed · boom",
    })
    expect(one({}, foreground({ status: "error", error: "Subagent cancelled (sessionID: a)" }))).toMatchObject({ state: "cancelled" })
  })

  test("with neither, the session's outcome; with nothing at all, idle", () => {
    expect(one({ outcome: "succeeded", time: { created: 1, idle: 900 } })).toMatchObject({ state: "done", ended: 900 })
    expect(one({ outcome: "failed" })).toMatchObject({ state: "failed", update: "failed" })
    expect(one({ outcome: "interrupted" })).toMatchObject({ state: "cancelled" })
    expect(one()).toMatchObject({ state: "idle", update: "idle" })
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

describe("which rows show", () => {
  const row = (over: Partial<Row>): Row => ({
    id: "a",
    depth: 0,
    role: "worker",
    tone: "worker",
    unit: "u",
    state: "running",
    update: "",
    since: 0,
    ...over,
  })
  const all = [
    row({ id: "run", since: 400 }),
    row({ id: "wait", state: "blocked" }),
    row({ id: "fresh", state: "done", ended: 1_000, since: undefined }),
    row({ id: "old", state: "done", ended: 0, since: undefined }),
    row({ id: "unknown", state: "idle", since: undefined }),
  ]

  test("running and blocked always, with how long they have run; a stopped one lingers, then drops; one with no end time never shows", () => {
    const now = 1_000 + LINGER_MS - 1
    expect(visible(all, now).map((value) => [value.id, value.elapsed])).toEqual([
      ["run", now - 400],
      ["wait", now],
      ["fresh", undefined],
    ])
    expect(visible(all, 1_000 + LINGER_MS).map((value) => value.id)).toEqual(["run", "wait"])
    expect(visible(all, 1_500, { linger: 100 }).map((value) => value.id)).toEqual(["run", "wait"])
  })

  test("the current session always shows", () => {
    expect(visible(all, 99_999, { current: "old" }).map((value) => value.id)).toEqual(["run", "wait", "old"])
  })

  test("rows reads the family and keeps the ones worth showing", () => {
    const world = family(
      session("root", { messages: [notice("b", "completed", 10)] }),
      session("a", { parentID: "root", time: { created: 1 }, running: true }),
      session("b", { parentID: "root", time: { created: 2 } }),
    )
    expect(rows(world, "root", 20).map((value) => [value.id, value.state, value.elapsed])).toEqual([
      ["a", "running", 19],
      ["b", "done", undefined],
    ])
    expect(rows(world, "root", 10 + LINGER_MS).map((value) => value.id)).toEqual(["a"])
  })
})

import { describe, expect, test } from "bun:test"
import { decide, sameActivity, type SessionView } from "./activity.ts"

const session = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  running: false,
  queued: false,
  permissions: [],
  questions: [],
  asked: [],
  tools: [],
  ...over,
})

describe("decide", () => {
  test("no session open: unknown, with no session", () => {
    expect(decide({ root: undefined, descendants: [] })).toEqual({ state: "unknown" })
  })

  test("a session at rest: idle, with its id and title", () => {
    expect(decide({ root: session("ses_root", { title: "  Fix the\nlogin " }), descendants: [] })).toEqual({
      state: "idle",
      sessionId: "ses_root",
      title: "Fix the login",
    })
  })

  test("the root runs: working, labelled with its running call", () => {
    const root = session("ses_root", { running: true, tools: [{ tool: "kernel", input: { code: "// fetch docs" }, at: 1 }] })
    expect(decide({ root, descendants: [] })).toEqual({ state: "working", sessionId: "ses_root", working: "kernel: fetch docs" })
  })

  test("the root is idle but a subagent it started runs: working, counted", () => {
    const view = { root: session("ses_root"), descendants: [session("ses_a", { running: true }), session("ses_b")] }
    expect(decide(view)).toEqual({ state: "working", sessionId: "ses_root", working: "1 subagent" })
  })

  test("queued input counts as work, with no label while nothing runs", () => {
    expect(decide({ root: session("ses_root", { queued: true }), descendants: [] })).toEqual({ state: "working", sessionId: "ses_root" })
  })

  test("a running subagent's call labels the work, newest first", () => {
    const view = {
      root: session("ses_root", { running: true, tools: [{ tool: "task", input: { description: "look" }, at: 1 }] }),
      descendants: [session("ses_a", { running: true, tools: [{ tool: "bash", input: { command: "ls" }, at: 2 }] })],
    }
    expect(decide(view).working).toBe("shell: ls · 1 subagent")
  })

  test("a waiting permission anywhere blocks, ahead of a question and of work", () => {
    const view = {
      root: session("ses_root", { running: true, questions: ["Which branch?"] }),
      descendants: [session("ses_a", { running: true, permissions: ["shell"] })],
    }
    expect(decide(view)).toEqual({ state: "blocked", sessionId: "ses_root", message: "Permission: shell" })
  })

  test("a waiting question blocks with its title", () => {
    const view = { root: session("ses_root", { running: true, questions: ["Which\nbranch?"] }), descendants: [] }
    expect(decide(view)).toEqual({ state: "blocked", sessionId: "ses_root", message: "Question: Which branch?" })
    expect(decide({ root: session("ses_root", { questions: [" "] }), descendants: [] }).message).toBe("Question needs input")
  })
})

describe("decide, with background questions open", () => {
  const db = { label: "Which\ndatabase?", at: 20 }
  const branch = { label: "Which branch?", at: 10 }

  test("nothing works and one is open: blocked, naming it", () => {
    expect(decide({ root: session("ses_root", { asked: [db] }), descendants: [] })).toEqual({
      state: "blocked",
      sessionId: "ses_root",
      message: "Question: Which database?",
    })
  })

  test("several open across the family: blocked, counted, naming the oldest", () => {
    const view = { root: session("ses_root", { asked: [db] }), descendants: [session("ses_a", { asked: [branch] })] }
    expect(decide(view)).toEqual({ state: "blocked", sessionId: "ses_root", message: "2 questions: Which branch?" })
    expect(decide({ root: session("ses_root", { asked: [{ label: " ", at: 1 }, { label: "", at: 2 }] }), descendants: [] }).message).toBe(
      "2 questions need input",
    )
  })

  test("work runs while they are open: working, with its label", () => {
    const root = session("ses_root", { running: true, asked: [db], tools: [{ tool: "bash", input: { command: "ls" }, at: 1 }] })
    expect(decide({ root, descendants: [] })).toEqual({ state: "working", sessionId: "ses_root", working: "shell: ls" })
    const view = { root: session("ses_root", { asked: [db] }), descendants: [session("ses_a", { queued: true })] }
    expect(decide(view).state).toBe("working")
  })

  test("a waiting permission or question form still comes first", () => {
    const view = { root: session("ses_root", { asked: [branch], questions: ["Pick one"] }), descendants: [session("ses_a", { permissions: ["edit"] })] }
    expect(decide(view).message).toBe("Permission: edit")
    expect(decide({ root: session("ses_root", { asked: [branch], questions: ["Pick one"] }), descendants: [] }).message).toBe("Question: Pick one")
  })

  test("once answered or withdrawn, none is open: idle", () => {
    expect(decide({ root: session("ses_root", { asked: [] }), descendants: [] })).toEqual({ state: "idle", sessionId: "ses_root" })
  })
})

describe("sameActivity", () => {
  test("compares every field herdr shows", () => {
    const a = { state: "working" as const, sessionId: "s", title: "t", working: "shell: ls" }
    expect(sameActivity(a, { ...a })).toBe(true)
    expect(sameActivity(a, { ...a, working: "shell: pwd" })).toBe(false)
    expect(sameActivity(a, { ...a, state: "idle" })).toBe(false)
    expect(sameActivity(a, { ...a, title: undefined })).toBe(false)
  })
})

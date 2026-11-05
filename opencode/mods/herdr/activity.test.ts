import { describe, expect, test } from "bun:test"
import { decide, sameActivity, type SessionView } from "./activity.ts"

const session = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  running: false,
  queued: false,
  permissions: [],
  questions: [],
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

describe("sameActivity", () => {
  test("compares every field herdr shows", () => {
    const a = { state: "working" as const, sessionId: "s", title: "t", working: "shell: ls" }
    expect(sameActivity(a, { ...a })).toBe(true)
    expect(sameActivity(a, { ...a, working: "shell: pwd" })).toBe(false)
    expect(sameActivity(a, { ...a, state: "idle" })).toBe(false)
    expect(sameActivity(a, { ...a, title: undefined })).toBe(false)
  })
})

// Reading the family from the TUI's data, as `context.data` answers.
import { describe, expect, test } from "bun:test"
import { read, type Reads, type SessionInfo } from "./view.ts"

interface Fixture {
  readonly info: SessionInfo
  readonly status?: "idle" | "running"
  readonly permissions?: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
  readonly forms?: ReadonlyArray<string>
  readonly messages?: ReadonlyArray<unknown>
}

const reads = (sessions: Readonly<Record<string, Fixture>>): Reads => ({
  session: {
    get: (id) => sessions[id]?.info,
    root: (id) => {
      let at = id
      for (let parent = sessions[at]?.info.parentID; parent; parent = sessions[at]?.info.parentID) at = parent
      return at
    },
    family: (id) => Object.keys(sessions).filter((key) => key !== id),
    status: (id) => sessions[id]?.status ?? "idle",
    permission: { list: (id) => sessions[id]?.permissions },
    form: { list: (id) => sessions[id]?.forms?.map((title) => ({ title })) },
    message: { list: (id) => sessions[id]?.messages ?? [] },
  },
})

describe("read", () => {
  const world = reads({
    root: {
      info: { id: "root", parentID: null, title: "three workers", time: { created: 0 } },
      messages: [
        { type: "user", id: "u", text: "go" },
        {
          type: "assistant",
          agent: "build",
          content: [
            { type: "reasoning", text: "Start them." },
            { type: "tool", name: "subagent", time: { created: 1, completed: 2 }, state: { status: "completed", input: { description: "Fix CSV" }, metadata: { sessionID: "a" } } },
            { type: "tool", name: "bash", time: { created: 3 }, state: { status: "streaming", input: "{\"comm", metadata: { sessionID: "x" } } },
            { type: "tool", name: "bash", time: { created: 3 }, state: { status: "error", input: {}, error: { message: "nope" } } },
            { type: "file", url: "x" },
          ],
        },
        { type: "synthetic", time: { created: 9 }, text: "done", metadata: { source: "subagent", childID: "a", state: "completed" } },
        { type: "synthetic", time: { created: 9 }, text: "plan", metadata: { source: "plan" } },
      ],
    },
    a: {
      info: { id: "a", parentID: "root", title: "Fix CSV", agent: "worker", outcome: "succeeded", time: { created: 1, busy: 2, idle: 8 } },
      status: "running",
      permissions: [{ action: "shell", resources: ["rm out"] }, { action: "edit", resources: [] }],
      forms: ["Which?"],
    },
  })
  const family = read(world, "a")

  test("reads from the root of the session, whichever session of the family the route shows", () => {
    expect(family.root).toBe("root")
    expect(family.sessions.map((session) => session.id)).toEqual(["root", "a"])
  })

  test("each session's fields, run status, permissions and questions", () => {
    expect(family.sessions[1]).toMatchObject({
      id: "a",
      parentID: "root",
      title: "Fix CSV",
      agent: "worker",
      outcome: "succeeded",
      time: { created: 1, busy: 2, idle: 8 },
      running: true,
      permissions: ["shell rm out", "edit"],
      questions: ["Which?"],
      messages: [],
    })
    expect(family.sessions[0]).not.toHaveProperty("parentID")
  })

  test("assistant steps with their words and calls, and the subagent stop notices; nothing else", () => {
    expect(family.sessions[0]?.messages).toEqual([
      {
        type: "assistant",
        agent: "build",
        parts: [
          { type: "words", text: "Start them." },
          { type: "call", tool: "subagent", status: "completed", input: { description: "Fix CSV" }, metadata: { sessionID: "a" }, completed: 2 },
          { type: "call", tool: "bash", status: "streaming", input: {}, metadata: {} },
          { type: "call", tool: "bash", status: "error", input: {}, metadata: {}, error: "nope" },
        ],
      },
      { type: "notice", childID: "a", state: "completed", at: 9, text: "done" },
    ])
  })
})

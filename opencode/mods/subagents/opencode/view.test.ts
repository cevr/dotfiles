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

describe("a session's background work", () => {
  const world = reads({
    root: { info: { id: "root", time: { created: 0 } } },
    a: {
      info: { id: "a", parentID: "root", time: { created: 1 } },
      messages: [
        {
          type: "assistant",
          content: [
            { type: "tool", name: "shell", time: { created: 2, completed: 3 }, state: { status: "completed", input: { command: "sleep 2", background: true }, metadata: { status: "running", shellID: "sh_1" } } },
            {
              type: "tool",
              name: "kernel",
              time: { created: 4, completed: 5 },
              state: {
                status: "completed",
                input: { code: "await tools.shell({ command: 'bun test', background: true })" },
                metadata: {
                  operations: [
                    { tool: "shell", status: "completed", input: { command: "bun test", background: true }, output: "moved", metadata: { shellID: "sh_2" } },
                    { tool: "read", status: "error", input: { path: "x" }, error: "missing" },
                    { tool: 7, status: "completed", input: {} },
                  ],
                },
              },
            },
          ],
        },
        { type: "synthetic", time: { created: 6 }, text: "<shell>", metadata: { source: "shell", shellID: "sh_1", jobID: "sh_1", state: "completed" } },
        { type: "synthetic", time: { created: 7 }, text: "<shell>", metadata: { source: "shell", state: "completed" } },
      ],
    },
  })

  test("a kernel call carries the tools its cell called, and a shell's stop notice names its shell", () => {
    expect(read(world, "a").sessions[1]?.messages).toEqual([
      {
        type: "assistant",
        parts: [
          { type: "call", tool: "shell", status: "completed", input: { command: "sleep 2", background: true }, metadata: { status: "running", shellID: "sh_1" }, completed: 3 },
          {
            type: "call",
            tool: "kernel",
            status: "completed",
            input: { code: "await tools.shell({ command: 'bun test', background: true })" },
            metadata: expect.objectContaining({ operations: expect.any(Array) }),
            completed: 5,
            calls: [
              { type: "call", tool: "shell", status: "completed", input: { command: "bun test", background: true }, metadata: { shellID: "sh_2" } },
              { type: "call", tool: "read", status: "error", input: { path: "x" }, metadata: {}, error: "missing" },
            ],
          },
        ],
      },
      { type: "shell", shellID: "sh_1", state: "completed", at: 6 },
    ])
  })
})

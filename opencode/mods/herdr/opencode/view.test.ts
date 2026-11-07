import { describe, expect, test } from "bun:test"
import { decide } from "../activity.ts"
import { membersOf, read, type Reads } from "./view.ts"

interface Fixture {
  readonly title?: string
  readonly status?: "idle" | "running"
  readonly pending?: ReadonlyArray<string>
  readonly permissions?: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
  readonly forms?: ReadonlyArray<string>
  readonly messages?: ReadonlyArray<{ readonly type: string; readonly content?: unknown }>
}

/** The TUI's data for a root `ses_root` whose family is `family`, as `context.data` would answer. */
const reads = (sessions: Readonly<Record<string, Fixture>>, family: ReadonlyArray<string>): Reads => ({
  session: {
    get: (id) => {
      const title = sessions[id]?.title
      if (sessions[id] === undefined) return undefined
      return title === undefined ? {} : { title }
    },
    root: (id) => (id in sessions ? "ses_root" : id),
    family: (id) => (id === "ses_root" ? family : []),
    status: (id) => sessions[id]?.status ?? "idle",
    pending: { list: (id) => (sessions[id]?.pending ?? []).map((type) => ({ type })) },
    permission: { list: (id) => sessions[id]?.permissions },
    form: { list: (id) => sessions[id]?.forms?.map((title) => ({ title })) },
    message: { list: (id) => sessions[id]?.messages ?? [] },
  },
})

const tool = (name: string, status: string, input: Record<string, unknown>, time: Record<string, number>) => ({
  type: "tool",
  id: `prt_${name}`,
  name,
  state: { status, input, metadata: {} },
  time,
})

describe("read", () => {
  test("off a session route there is no session", () => {
    const data = reads({ ses_root: {} }, [])
    expect(read(data, { type: "home" })).toEqual({ root: undefined, descendants: [] })
    expect(read(data, { type: "session", sessionID: "dummy" })).toEqual({ root: undefined, descendants: [] })
  })

  test("a subagent's route reads its root and the root's whole family", () => {
    const data = reads({ ses_root: { title: "Root" }, ses_child: { status: "running" } }, ["ses_root", "ses_child"])
    const view = read(data, { type: "session", sessionID: "ses_child" })
    expect(view.root?.id).toBe("ses_root")
    expect(view.root?.title).toBe("Root")
    expect(view.descendants.map((member) => [member.id, member.running])).toEqual([["ses_child", true]])
  })

  test("synthetic pending input is not queued work; a user's is", () => {
    expect(read(reads({ ses_root: { pending: ["synthetic"] } }, []), { type: "session", sessionID: "ses_root" }).root?.queued).toBe(false)
    expect(read(reads({ ses_root: { pending: ["synthetic", "user"] } }, []), { type: "session", sessionID: "ses_root" }).root?.queued).toBe(true)
  })

  test("permissions read as their action and first resource, questions as their title", () => {
    const data = reads({ ses_root: { permissions: [{ action: "shell", resources: ["rm -rf build"] }, { action: "edit", resources: [] }], forms: ["Pick one"] } }, [])
    const root = read(data, { type: "session", sessionID: "ses_root" }).root
    expect(root?.permissions).toEqual(["shell rm -rf build", "edit"])
    expect(root?.questions).toEqual(["Pick one"])
  })

  test("each member carries its open background questions; idle on them, the view blocks", () => {
    const data = reads({ ses_root: {}, ses_child: {} }, ["ses_root", "ses_child"])
    const asked = (id: string) => (id === "ses_child" ? [{ label: "Which branch?", at: 5 }] : [])
    const view = read(data, { type: "session", sessionID: "ses_root" }, asked)
    expect(view.root?.asked).toEqual([])
    expect(view.descendants.map((member) => member.asked)).toEqual([[{ label: "Which branch?", at: 5 }]])
    expect(decide(view)).toEqual({ state: "blocked", sessionId: "ses_root", message: "Question: Which branch?" })
    expect(read(data, { type: "session", sessionID: "ses_root" }).root?.asked).toEqual([])
  })

  test("the members are the root first, then its family; none off a session", () => {
    const data = reads({ ses_root: {}, ses_child: {} }, ["ses_root", "ses_child"])
    expect(membersOf(data, { type: "session", sessionID: "ses_child" })).toEqual(["ses_root", "ses_child"])
    expect(membersOf(data, { type: "home" })).toEqual([])
  })

  test("the running calls of the newest assistant message, with when each started running", () => {
    const messages = [
      { type: "assistant", content: [tool("bash", "running", { command: "stale" }, { created: 1 })] },
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "on it" },
          tool("kernel", "running", { code: "// fetch the docs" }, { created: 5, ran: 7 }),
          tool("bash", "streaming", { command: "partial" }, { created: 8 }),
          tool("read", "completed", { path: "/a" }, { created: 2, completed: 3 }),
        ],
      },
    ]
    const view = read(reads({ ses_root: { status: "running", messages } }, []), { type: "session", sessionID: "ses_root" })
    expect(view.root?.tools).toEqual([{ tool: "kernel", input: { code: "// fetch the docs" }, at: 7 }])
    expect(decide(view)).toEqual({ state: "working", sessionId: "ses_root", working: "kernel: fetch the docs" })
  })
})

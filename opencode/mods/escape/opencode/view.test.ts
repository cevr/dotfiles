import { describe, expect, test } from "bun:test"
import { read, type Message, type Reads } from "./view.ts"

interface Fixture {
  readonly parentID?: string
  readonly revert?: string
  readonly status?: "idle" | "running"
  readonly pending?: ReadonlyArray<{ readonly id: string; readonly type: string }>
  readonly permissions?: number
  readonly forms?: number
  readonly messages?: ReadonlyArray<Message>
}

/** The TUI's data, as `context.data` would answer; `ses_root`'s family is every session given. */
const reads = (sessions: Readonly<Record<string, Fixture>>): Reads => ({
  session: {
    get: (id) => {
      const session = sessions[id]
      if (session === undefined) return undefined
      return { ...(session.parentID === undefined ? {} : { parentID: session.parentID }), ...(session.revert === undefined ? {} : { revert: { messageID: session.revert } }) }
    },
    family: (id) => (id === "ses_root" ? Object.keys(sessions) : [id]),
    status: (id) => sessions[id]?.status ?? "idle",
    pending: { list: (id) => sessions[id]?.pending ?? [] },
    permission: { list: (id) => Array.from({ length: sessions[id]?.permissions ?? 0 }) },
    form: { list: (id) => Array.from({ length: sessions[id]?.forms ?? 0 }) },
    message: { list: (id) => sessions[id]?.messages ?? [] },
  },
})

const user = (id: string, text: string, created: number): Message => ({ id, type: "user", text, time: { created } })
const answer = (id: string, tools: ReadonlyArray<string> = []): Message => ({
  id,
  type: "assistant",
  content: [{ type: "text" }, ...tools.map((name) => ({ type: "tool", name }))],
  time: { created: 0 },
})
const route = { type: "session", sessionID: "ses_root" } as const
const empty = { plainText: "" }

describe("read", () => {
  test("off a session, or for a session the TUI has not loaded, there is no view", () => {
    expect(read(reads({ ses_root: {} }), { type: "home" }, empty)).toBeUndefined()
    expect(read(reads({}), route, empty)).toBeUndefined()
  })

  test("the newest prompt with text, past the assistant's answer and any synthetic note", () => {
    const messages = [user("msg_1", "First", 1), answer("msg_2"), user("msg_3", "Second", 3), { id: "msg_4", type: "synthetic", text: "note", time: { created: 4 } }, user("msg_5", "  ", 5), answer("msg_6")]
    const view = read(reads({ ses_root: { status: "running", messages } }), route, empty)
    expect(view).toEqual({
      sessionID: "ses_root",
      subagent: false,
      busy: true,
      blocked: false,
      latest: { id: "msg_3", created: 3, pending: false, ranShell: false },
      composer: "empty",
    })
  })

  test("a staged revert hides the prompts from it on, as the host's session.undo does", () => {
    const messages = [user("msg_1", "First", 1), answer("msg_2"), user("msg_3", "Second", 3)]
    expect(read(reads({ ses_root: { messages, revert: "msg_3" } }), route, empty)?.latest?.id).toBe("msg_1")
  })

  test("a prompt still in the inbox reads pending; a synthetic inbox item does not count", () => {
    const messages = [user("msg_1", "First", 1)]
    expect(read(reads({ ses_root: { messages, pending: [{ id: "msg_1", type: "user" }] } }), route, empty)?.latest?.pending).toBe(true)
    expect(read(reads({ ses_root: { messages, pending: [{ id: "msg_1", type: "synthetic" }] } }), route, empty)?.latest?.pending).toBe(false)
  })

  test("a shell call after the prompt is noted; one before it is not", () => {
    const after = [user("msg_1", "First", 1), answer("msg_2", ["read", "shell"])]
    const before = [answer("msg_0", ["bash"]), user("msg_1", "First", 1), answer("msg_2", ["read"])]
    expect(read(reads({ ses_root: { messages: after } }), route, empty)?.latest?.ranShell).toBe(true)
    expect(read(reads({ ses_root: { messages: before } }), route, empty)?.latest?.ranShell).toBe(false)
  })

  test("the focused editor's text is the composer: empty, a draft, or no editor at all", () => {
    const data = reads({ ses_root: {} })
    expect(read(data, route, empty)?.composer).toBe("empty")
    expect(read(data, route, { plainText: "[Image 1] " })?.composer).toBe("draft")
    expect(read(data, route, null)?.composer).toBe("none")
  })

  test("a permission or question anywhere in a root's family blocks it; a subagent's view reads its own", () => {
    expect(read(reads({ ses_root: {}, ses_child: { parentID: "ses_root", permissions: 1 } }), route, empty)?.blocked).toBe(true)
    expect(read(reads({ ses_root: { forms: 1 } }), route, empty)?.blocked).toBe(true)
    const child = read(reads({ ses_root: {}, ses_child: { parentID: "ses_root", status: "running" } }), { type: "session", sessionID: "ses_child" }, null)
    expect(child).toMatchObject({ sessionID: "ses_child", subagent: true, busy: true, blocked: false })
  })
})

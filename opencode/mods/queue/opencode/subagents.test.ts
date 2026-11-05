import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@dotfiles/opencode-subagents/family"
import { fromFamily } from "./subagents.ts"

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  parentID: "root",
  time: { created: 0 },
  running: false,
  permissions: [],
  questions: [],
  messages: [],
  ...over,
})
const thought = (text: string, agent = "worker"): Message => ({ type: "assistant", agent, parts: [{ type: "words", text }] })
const notice = (childID: string, state: string, at: number): Message => ({ type: "notice", childID, state, at, text: "" })
const launch = (child: string, description: string): Message => ({
  type: "assistant",
  parts: [{ type: "call", tool: "subagent", status: "completed", input: { description, background: true }, metadata: { sessionID: child } }],
})

describe("fromFamily", () => {
  test("maps every shared row, stopped ones long past their linger included, to the board's subagents", () => {
    const now = 1_000_000
    const family = {
      root: "root",
      sessions: [
        session("root", { parentID: undefined, messages: [launch("run", "Fix money parsing"), notice("old", "completed", 5), notice("gone", "cancelled", 6)] }),
        session("run", { agent: "implementor", time: { created: 1, busy: now - 65_000 }, running: true, messages: [thought("Check the money parser first. Then test.")] }),
        session("ask", { agent: "worker", title: "Ask", time: { created: 2 }, running: true, permissions: ["edit src/a.ts"] }),
        session("old", { agent: "verifier", title: "Old", time: { created: 3 } }),
        session("gone", { agent: "worker", title: "Gone", time: { created: 4 } }),
        session("bad", { agent: "worker", title: "Bad", outcome: "failed", time: { created: 5, idle: 7 } }),
        session("unknown", { title: "Unknown", time: { created: 6 } }),
      ],
    }
    expect(fromFamily(family, now)).toEqual([
      { session: "run", description: "Fix money parsing", live: { state: "running" }, role: "implementor", update: "Check the money parser first.", elapsed: 65_000 },
      { session: "ask", description: "Ask", live: { state: "blocked" }, role: "worker", update: "waiting on permission: edit src/a.ts", elapsed: now - 2 },
      { session: "old", description: "Old", live: { state: "done", since: 5 }, role: "verifier", update: "done · 0 steps" },
      { session: "gone", description: "Gone", live: { state: "failed", since: 6 }, role: "worker", update: "cancelled" },
      { session: "bad", description: "Bad", live: { state: "failed", since: 7 }, role: "worker", update: "failed" },
      { session: "unknown", description: "Unknown", live: { state: "done" }, role: "subagent", update: "idle" },
    ])
  })
})

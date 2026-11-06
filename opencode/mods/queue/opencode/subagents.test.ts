import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@dotfiles/opencode-subagents/family"
import { fromFamily } from "./subagents.ts"

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  parentID: "root",
  time: { created: 0 },
  running: false,
  shells: [],
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
  test("gives every shared row's live state by session, stopped ones long past their linger included", () => {
    const now = 1_000_000
    const family = {
      root: "root",
      sessions: [
        session("root", { parentID: undefined, messages: [launch("run", "Fix money parsing"), notice("old", "completed", 5), notice("gone", "cancelled", 6)] }),
        session("run", { agent: "implementor", time: { created: 1, busy: now - 65_000 }, running: true, messages: [thought("Check the money parser first. Then test.")] }),
        session("ask", { agent: "worker", title: "Ask", time: { created: 2 }, running: true, permissions: ["edit src/a.ts"] }),
        session("hold", {
          agent: "worker",
          title: "Hold",
          time: { created: 2 },
          running: true,
          messages: [{ type: "assistant", parts: [{ type: "call", tool: "bash", status: "running", input: { command: "sleep 60" }, metadata: {} }] }],
        }),
        session("old", { agent: "verifier", title: "Old", time: { created: 3 } }),
        session("gone", { agent: "worker", title: "Gone", time: { created: 4 } }),
        session("bad", { agent: "worker", title: "Bad", outcome: "failed", time: { created: 5, idle: 7 } }),
        session("unknown", { title: "Unknown", time: { created: 6 } }),
        session("queued", { agent: "worker", title: "Queued", time: { created: 7 }, latch: { hold: "pace", reason: "held", opensAt: now + 60_000, at: now } }),
      ],
    }
    expect([...fromFamily(family)]).toEqual([
      ["run", { state: "running" }],
      ["ask", { state: "blocked" }],
      ["hold", { state: "waiting" }],
      ["old", { state: "done", since: 5 }],
      ["gone", { state: "failed", since: 6 }],
      ["bad", { state: "failed", since: 7 }],
      ["unknown", { state: "done" }],
      // A latched subagent is queued work: it waits.
      ["queued", { state: "waiting" }],
    ])
  })
})

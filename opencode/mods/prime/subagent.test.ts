// Moving between a session and its subagents: the child a call opens, the
// order ←/→ walks, and the hints.
import { describe, expect, test } from "bun:test"
import type { ToolPart, ToolState } from "./session.ts"
import { navigationHint, neighbour, subagentOrder, subagentSession, topTitle, type SessionNode } from "./subagent.ts"

const part = (state: ToolState): ToolPart => ({ type: "tool", id: "call_1", name: "subagent", time: { created: 0 }, state })

describe("the session a subagent call opens", () => {
  test("is the metadata's sessionID: live while the call runs, final once it returns or fails", () => {
    expect(subagentSession(part({ status: "running", input: {}, metadata: { sessionID: "ses_a", status: "running" } }))).toBe("ses_a")
    expect(
      subagentSession(part({ status: "completed", input: {}, content: [], metadata: { sessionID: "ses_b", status: "running" } })),
    ).toBe("ses_b")
    expect(subagentSession(part({ status: "error", input: {}, error: {}, metadata: { sessionID: "ses_c" } }))).toBe("ses_c")
  })

  test("is unknown before the call starts its child, or when the metadata has none", () => {
    expect(subagentSession(part({ status: "streaming", input: "{" }))).toBeUndefined()
    expect(subagentSession(part({ status: "running", input: {}, metadata: {} }))).toBeUndefined()
    expect(subagentSession(part({ status: "completed", input: {}, content: [] }))).toBeUndefined()
    expect(subagentSession(part({ status: "completed", input: {}, content: [], metadata: { sessionID: 7 } }))).toBeUndefined()
  })
})

// root ─ a ─ a1
//      ├ b
//      └ c          (listed newest first, as the host's list may be)
const at = (created: number) => ({ created })
const family: SessionNode[] = [
  { id: "c", parentID: "root", time: at(30) },
  { id: "a1", parentID: "a", time: at(15) },
  { id: "b", parentID: "root", time: at(20) },
  { id: "root", time: at(0) },
  { id: "a", parentID: "root", time: at(10) },
  { id: "other", time: at(5) },
]

describe("the order ←/→ walk", () => {
  test("is every subagent under the root, depth first, siblings in the order they started", () => {
    expect(subagentOrder(family, "root")).toEqual(["a", "a1", "b", "c"])
    expect(subagentOrder(family, "a1")).toEqual(["a", "a1", "b", "c"])
    expect(subagentOrder(family, "other")).toEqual([])
  })

  test("ends on a parent cycle", () => {
    expect(subagentOrder([{ id: "x", parentID: "y" }, { id: "y", parentID: "x" }], "x")).toEqual(["y"])
  })

  test("moves to the next or previous reachable subagent, wrapping around", () => {
    const order = ["a", "a1", "b", "c"]
    const all = () => true
    expect(neighbour(order, "a", 1, all)).toBe("a1")
    expect(neighbour(order, "c", 1, all)).toBe("a")
    expect(neighbour(order, "a", -1, all)).toBe("c")
  })

  test("skips the ones it cannot reach, but keeps the current one in its place", () => {
    const running = (id: string) => id === "a" || id === "c"
    expect(neighbour(["a", "b", "c"], "b", 1, running)).toBe("c")
    expect(neighbour(["a", "b", "c"], "b", -1, running)).toBe("a")
  })

  test("goes nowhere when no other subagent is reachable", () => {
    expect(neighbour(["a", "b"], "a", 1, () => false)).toBeUndefined()
    expect(neighbour(["a", "b"], "z", 1, () => true)).toBeUndefined()
  })
})

describe("the hints", () => {
  test("a session with subagents running points down to them; one without says nothing", () => {
    expect(navigationHint({ child: false, others: 3 })).toBe("↓ subagents")
    expect(navigationHint({ child: false, others: 0 })).toBe("")
  })

  test("a subagent points back up, and across while another runs", () => {
    expect(navigationHint({ child: true, others: 2 })).toBe("↑ back to parent · ←/→ other subagents")
    expect(navigationHint({ child: true, others: 0 })).toBe("↑ back to parent")
  })

  test("a subagent's title reads behind its parent's", () => {
    const parent = { id: "root", title: "three workers" }
    expect(topTitle({ id: "a", parentID: "root", title: "Fix CSV quoting" }, parent)).toEqual({
      parent: "three workers",
      title: "Fix CSV quoting",
    })
    expect(topTitle(parent, undefined)).toEqual({ title: "three workers" })
    expect(topTitle({ id: "a", parentID: "root", title: "Fix CSV quoting" }, undefined)).toEqual({ title: "Fix CSV quoting" })
  })
})

import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { look, nothingSeen } from "./family.ts"
import { paneOf, paneVariablesIn, sessionVariables } from "./pane.ts"

describe("the pane a process belongs to", () => {
  test("is named by REX_SESSION and REX_BLOCK together, never by one alone or an empty one", () => {
    expect(paneOf({ REX_SESSION: "session:1", REX_BLOCK: "block:2" })).toEqual(Option.some({ session: "session:1", block: "block:2" }))
    expect(paneOf({ REX_SESSION: "session:1" })).toEqual(Option.none())
    expect(paneOf({ REX_SESSION: "session:1", REX_BLOCK: "" })).toEqual(Option.none())
  })

  test("the server takes out only the pane's two variables; the host's server and tool stay", () => {
    expect(paneVariablesIn({ REX_SESSION: "s", REX_BLOCK: "b", REX_SERVER: "unix:/x", REX_BIN_DIR: "/bin", PATH: "/bin" })).toEqual(["REX_SESSION", "REX_BLOCK"])
    expect(paneVariablesIn({ PATH: "/bin" })).toEqual([])
  })

  test("a TUI's environment as a session's leaves out the server's password", () => {
    expect(sessionVariables({ PATH: "/bin", REX_BLOCK: "b", OPENCODE_PASSWORD: "x", OPENCODE_SERVER_PASSWORD: "y" })).toEqual({
      PATH: "/bin",
      REX_BLOCK: "b",
    })
  })
})

describe("when a subagent gets its TUI's environment", () => {
  test("each member is due when it first appears, and again only when it starts to run", () => {
    const first = look(nothingSeen, [{ id: "a", running: true }, { id: "b", running: false }])
    expect(first.due).toEqual(["a", "b"])
    const same = look(first.seen, [{ id: "a", running: true }, { id: "b", running: false }])
    expect(same.due).toEqual([])
    const resumed = look(same.seen, [{ id: "a", running: false }, { id: "b", running: true }])
    expect(resumed.due).toEqual(["b"])
    const idle = look(resumed.seen, [{ id: "a", running: true }, { id: "b", running: false }])
    expect(idle.due).toEqual(["a"])
  })

  test("a member that leaves the family and comes back is due again", () => {
    const first = look(nothingSeen, [{ id: "a", running: false }])
    const gone = look(first.seen, [])
    expect(look(gone.seen, [{ id: "a", running: false }]).due).toEqual(["a"])
  })
})

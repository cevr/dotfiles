import { describe, expect, test } from "bun:test"
import { aliasOf, misnamed, nearest, oneEdit } from "./near-miss.ts"

const TOOLS = ["shell", "read", "edit", "patch", "message", "sessions", "rift", "opencode_session_move"]

describe("one edit", () => {
  test("an insertion, a deletion, a substitution and a swap of neighbours are one edit; two are not", () => {
    expect(oneEdit("shell", "shll")).toBe(true)
    expect(oneEdit("shell", "shelll")).toBe(true)
    expect(oneEdit("shell", "shekl")).toBe(true)
    expect(oneEdit("shell", "sehll")).toBe(true)
    expect(oneEdit("shell", "shel")).toBe(true)
    expect(oneEdit("shell", "sell")).toBe(true)
    expect(oneEdit("shell", "hsll")).toBe(false)
    expect(oneEdit("shell", "sh")).toBe(false)
  })
})

describe("the tool a name nearly names", () => {
  test("a case or one-edit miss names the real tool", () => {
    expect(nearest("shll", TOOLS)).toEqual({ tool: "shell", call: "shell" })
    expect(nearest("Shell", TOOLS)).toEqual({ tool: "shell", call: "shell" })
    expect(nearest("mesage", TOOLS)).toEqual({ tool: "message", call: "message" })
    expect(nearest("opencode_sesion_move", TOOLS)).toEqual({ tool: "opencode_session_move", call: "opencode_session_move" })
  })

  test("a real name, a far name, an ambiguous one and a very short one name nothing", () => {
    expect(nearest("shell", TOOLS)).toBeUndefined()
    expect(nearest("bash", TOOLS)).toBeUndefined()
    expect(nearest("rea", TOOLS)).toEqual({ tool: "read", call: "read" })
    expect(nearest("redd", ["read", "reed"])).toBeUndefined()
    expect(nearest("sh", ["s", "sh2"])).toBeUndefined()
  })

  test("a miss of a provider's alias names the alias of the real tool, case first", () => {
    expect(aliasOf("edit")).toBe("mcp_TZWRpdA")
    // The workbox's measured misses: a lower-cased letter and one letter added.
    expect(nearest("mcp_TzWRpdA", TOOLS)).toEqual({ tool: "edit", call: "mcp_TZWRpdA" })
    expect(nearest("mcp_TDZWRpdA", TOOLS)).toEqual({ tool: "edit", call: "mcp_TZWRpdA" })
    expect(nearest("mcp_TZZZZZZZ", TOOLS)).toBeUndefined()
  })

  test("the answer names what to call", () => {
    expect(misnamed("shll", { tool: "shell", call: "shell" })).toBe('There is no "shll" tool; did you mean "shell"? Call "shell" with the same input.')
    expect(misnamed("mcp_TzWRpdA", { tool: "edit", call: "mcp_TZWRpdA" })).toBe(
      'There is no "mcp_TzWRpdA" tool; did you mean "mcp_TZWRpdA" (edit)? Call "mcp_TZWRpdA" with the same input.',
    )
  })
})

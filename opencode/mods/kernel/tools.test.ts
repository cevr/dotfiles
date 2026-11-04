// The tools a cell reaches, as values: which ones its rules leave it, how the
// model reads them, and what a tool's result is to the cell.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { callable, catalog, notATool, plain, reachable, textOf, typeOf, whollyDisabled } from "./tools.ts"

describe("whollyDisabled", () => {
  test("follows the last matching rule, as the registry does", () => {
    expect(whollyDisabled("execute", [{ action: "execute", resource: "*", effect: "deny" }])).toBe(true)
    expect(whollyDisabled("execute", [{ action: "*", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "allow" }])).toBe(false)
    expect(whollyDisabled("shell", [{ action: "shell", resource: "rm *", effect: "deny" }])).toBe(false)
  })
})

describe("callable", () => {
  test("leaves out the code tools, the hooked tools and those the rules deny, by their permission", () => {
    const tools = [{ id: "read" }, { id: "kernel" }, { id: "execute" }, { id: "subagent" }, { id: "edit" }, { id: "write", permission: "edit" }]
    expect([...callable(tools, []).keys()]).toEqual(["read", "edit", "write"])
    expect([...callable(tools, [{ action: "edit", resource: "*", effect: "deny" }]).keys()]).toEqual(["read"])
  })
})

describe("reachable", () => {
  test("is every runtime tool but the code tools, subagent included", () => {
    const tools = ["read", "subagent", "kernel", "execute"].map((name) => ({ name, description: name, input: {} }))
    expect(reachable(tools).map((tool) => tool.name)).toEqual(["read", "subagent"])
  })
})

describe("notATool", () => {
  test("names the tools there are, sorted, or none", () => {
    expect(notATool("kernel", ["tools.read", "tools.edit"])).toBe("kernel is not a tool here. Tools: tools.edit, tools.read")
    expect(notATool("kernel", [])).toBe("kernel is not a tool here. Tools: none")
  })
})

describe("the catalog", () => {
  test("lists each tool the kernel reaches with its input, quoting a name that is not an identifier", () => {
    const text = catalog([
      { name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
      { name: "mcp-search", description: "Search", input: { type: "object", properties: { mode: { enum: ["a", "b"] } } } },
      { name: "kernel", description: "itself", input: {} },
    ])
    expect(text).toContain("### tools.read(input: { path: string, limit?: number })\nRead a file")
    expect(text).toContain('### tools["mcp-search"](input: { mode?: "a" | "b" })\nSearch')
    expect(text).not.toContain("tools.kernel")
  })

  test("reads unions, arrays, constants and nullable types; deep objects stay `object`", () => {
    expect(typeOf({ anyOf: [{ type: "string" }, { const: 1 }] })).toBe('string | 1')
    expect(typeOf({ type: "array", items: { type: ["number", "null"] } })).toBe("number[]")
    expect(typeOf({ type: "object", properties: {} })).toBe("{}")
    const deep = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: {} } } } } } } } }
    expect(typeOf(deep)).toBe("{ a?: { b?: { c?: object } } }")
    expect(typeOf("not a schema")).toBe("unknown")
  })
})

describe("a tool's result to a cell", () => {
  test("is its text parts joined, else null", () => {
    expect(textOf("done")).toBe("done")
    expect(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb")
    expect(textOf([{ type: "image" }])).toBeNull()
    expect(textOf(undefined)).toBeNull()
  })

  test("is plain data: undefined fields dropped, what JSON cannot write null, and a value it refuses a failed call", () => {
    expect(Effect.runSync(plain({ a: 1, b: undefined, when: new Date(0) }))).toEqual({ a: 1, when: "1970-01-01T00:00:00.000Z" })
    expect(Effect.runSync(plain(undefined))).toBeNull()
    const refused = Effect.runSyncExit(plain(1n))
    expect(Exit.isFailure(refused) && refused.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "CallFailed")).toBe(true)
  })
})

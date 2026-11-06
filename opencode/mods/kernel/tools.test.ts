// The tools a cell reaches, as values: which ones its rules leave it, how the
// model reads them, and what a tool's result is to the cell.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { Json } from "./frame.ts"
import { callable, catalog, cellValue, contentValue, IMAGE_NOTE, notATool, plain, reachable, textOf, typeOf, whollyDisabled, withoutImages } from "./tools.ts"

describe("whollyDisabled", () => {
  test("follows the last matching rule, as the registry does", () => {
    expect(whollyDisabled("execute", [{ action: "execute", resource: "*", effect: "deny" }])).toBe(true)
    expect(whollyDisabled("execute", [{ action: "*", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "allow" }])).toBe(false)
    expect(whollyDisabled("shell", [{ action: "shell", resource: "rm *", effect: "deny" }])).toBe(false)
  })
})

describe("callable", () => {
  test("leaves out the code tools, the hooked tools and those the rules deny, by their permission", () => {
    const tools = [{ id: "read" }, { id: "kernel" }, { id: "execute" }, { id: "subagent" }, { id: "shell" }, { id: "bash" }, { id: "edit" }, { id: "write", permission: "edit" }]
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

  test("says under the shell tool that a cell gets its handle as a live object", () => {
    const text = catalog([{ name: "shell", description: "Execute a shell command and return its handle.", input: {} }])
    expect(text).toContain("Execute a shell command and return its handle.\n\nIn a cell, `tools.shell({ command,")
    expect(text).toContain("only runs a command, and resolves to a live handle")
    expect(text).toContain("`await tools.shell.handle(id)`")
    expect(text).toContain("`await tools.shell.list()`")
    expect(text).toContain("The tool's other actions (check, wait, kill, list) are these methods in a cell")
    expect(text).not.toMatch(/kill: true|list: true|wait: |action: "/)
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

describe("an image in a tool's result", () => {
  const marker = (name?: string) => ({ type: "image", mime: "image/png", ...(name === undefined ? {} : { name }), note: IMAGE_NOTE })

  test("is a marker at any depth of an output: base64 content or a data URI, named by its name or file URL", () => {
    expect(
      withoutImages({
        page: { type: "file", mime: "image/png", encoding: "base64", content: "AAAA", uri: "file:///w/a.png" },
        list: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "b.png" }],
        inline: { mime: "image/png", uri: "data:image/png;base64,AAAA" },
      }),
    ).toEqual({ page: marker("/w/a.png"), list: [marker("b.png")], inline: marker() })
  })

  test("leaves text, a linked image and a non-image file alone", () => {
    const kept: Json = [
      { type: "file", mime: "text/plain", encoding: "base64", content: "AAAA" },
      { type: "file", mime: "image/png", uri: "https://example.com/a.png" },
      { mime: "image/png", encoding: "utf8", content: "not base64" },
      "image/png",
    ]
    expect(withoutImages(kept)).toEqual(kept)
  })

  test("in a result without an output turns its content into a list; without an image the text stays as it was", () => {
    expect(contentValue([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb")
    expect(contentValue("plain")).toBe("plain")
    expect(contentValue(undefined)).toBeNull()
    expect(
      contentValue([
        { type: "text", text: "Image read successfully" },
        { type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "shot.png" },
        { type: "file", mime: "application/pdf", uri: "data:application/pdf;base64,AAAA", name: "doc.pdf" },
      ]),
    ).toEqual([
      { type: "text", text: "Image read successfully" },
      { type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "shot.png" },
      { type: "file", mime: "application/pdf", name: "doc.pdf" },
    ])
  })

  test("reaches the cell as its marker, from the output or the content", async () => {
    const image = { type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "shot.png" }
    expect(await Effect.runPromise(cellValue({ output: image }))).toEqual(marker("shot.png"))
    expect(await Effect.runPromise(cellValue({ content: [{ type: "text", text: "read" }, image] }))).toEqual([
      { type: "text", text: "read" },
      marker("shot.png"),
    ])
  })
})

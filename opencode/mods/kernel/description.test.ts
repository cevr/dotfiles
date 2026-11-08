// The kernel tool's description, as the model reads it.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { description, KernelInput } from "./description.ts"
import { IMAGE_NOTE } from "./tools.ts"

describe("the input", () => {
  const decode = Schema.decodeUnknownSync(KernelInput)

  test("takes a short description of what the cell does", () => {
    expect(decode({ code: "1", description: "Merge the skill-dollar worker" })).toEqual({
      code: "1",
      description: "Merge the skill-dollar worker",
    })
  })

  test("decodes a call made before the description existed", () => {
    expect(decode({ code: "await tools.shell({ command: 'ls' })", reset: true })).toEqual({
      code: "await tools.shell({ command: 'ls' })",
      reset: true,
    })
  })

  test("says, to the model, what the description is for and gives an example", () => {
    const field = Schema.toJsonSchemaDocument(KernelInput).schema
    expect(JSON.stringify(field)).toContain("Merge the skill-dollar worker")
    expect(description({ timeoutMs: 30_000, viewChars: 8_000 })).toContain("the user sees it as the call's header")
  })
})

describe("the description", () => {
  test("as the runtime, says the kernel is the only tool and lists the others; as a direct tool, lists none", () => {
    const limits = { timeoutMs: 30_000, viewChars: 8_000 }
    const runtime = description(limits, [{ name: "read", description: "Read a file", input: {} }])
    expect(runtime).toContain("the kernel is your only tool")
    expect(runtime).toContain("## Tools\n\n- tools.read(input: unknown): Read a file")
    const direct = description(limits)
    expect(direct).not.toContain("the kernel is your only tool")
    expect(direct).toContain("tools.list()")
  })

  test("as the runtime beside direct tools, says so and leaves them off the list", () => {
    const words = { timeoutMs: 30_000, viewChars: 8_000, direct: ["memory_save"] }
    const text = description(words, [
      { name: "read", description: "Read a file", input: {} },
      { name: "memory_save", description: "Save a note", input: {} },
    ])
    expect(text).not.toContain("the kernel is your only tool")
    expect(text).toContain("the kernel is your main tool. The few tools offered beside it you call directly; a cell reaches them on `tools` too")
    expect(text).toContain("## Tools\n\n- tools.read(input: unknown): Read a file")
    expect(text).not.toContain("tools.memory_save")
    // Without the runtime the option changes nothing.
    expect(description(words)).toBe(description({ timeoutMs: 30_000, viewChars: 8_000 }))
  })

  test("in either mode, says to read a tool's docs before its first call, and how", () => {
    const limits = { timeoutMs: 30_000, viewChars: 8_000 }
    for (const text of [description(limits), description(limits, [])]) {
      expect(text).toContain("Read a tool's docs before its first call: `tools.docs(name)`")
      expect(text).toContain("`tools.docs.search(query)`")
    }
  })

  test("in either mode, says attach shows images and what a tool's image is to the code", () => {
    const limits = { timeoutMs: 30_000, viewChars: 8_000 }
    for (const text of [description(limits), description(limits, [])]) {
      expect(text).toContain("`attach(...paths: string[])` shows image files (PNG, JPEG, GIF, WebP;")
      expect(text).toContain(`{"type":"image","mime":"image/png","name":"<path>","note":"${IMAGE_NOTE}"}`)
    }
  })
})

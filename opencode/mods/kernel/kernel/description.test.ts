// The kernel tool's description, as the model reads it.
import { describe, expect, test } from "bun:test"
import { description } from "./description.ts"

describe("the description", () => {
  test("as the runtime, says the kernel is the only tool and lists the others; as a direct tool, lists none", () => {
    const limits = { timeoutMs: 30_000, viewChars: 8_000 }
    const runtime = description(limits, [{ name: "read", description: "Read a file", input: {} }])
    expect(runtime).toContain("the kernel is your only tool")
    expect(runtime).toContain("### tools.read(input: unknown)\nRead a file")
    const direct = description(limits)
    expect(direct).not.toContain("the kernel is your only tool")
    expect(direct).toContain("tools.list()")
  })
})

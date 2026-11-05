// The kernel tool's description, as the model reads it.
import { describe, expect, test } from "bun:test"
import { description } from "./description.ts"
import { IMAGE_NOTE } from "./tools.ts"

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

  test("in either mode, says attach shows images and what a tool's image is to the code", () => {
    const limits = { timeoutMs: 30_000, viewChars: 8_000 }
    for (const text of [description(limits), description(limits, [])]) {
      expect(text).toContain("`attach(...paths: string[])` shows image files (PNG, JPEG, GIF, WebP;")
      expect(text).toContain(`{"type":"image","mime":"image/png","name":"<path>","note":"${IMAGE_NOTE}"}`)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { clip, firstLine, LABEL_LIMIT, toolLabel, workingLabel, type RunningTool } from "./label.ts"

const call = (tool: string, input: Record<string, unknown>, at = 0): RunningTool => ({ tool, input, at })

describe("toolLabel", () => {
  test("a kernel cell reads as its first line that says something, comment markers dropped", () => {
    expect(toolLabel(call("kernel", { code: "\n// fetch the docs\nconst page = await fetch(url)" }))).toBe("kernel: fetch the docs")
    expect(toolLabel(call("kernel", { code: "const x = 1\nconst y = 2" }))).toBe("kernel: const x = 1")
  })

  test("a shell call reads as its command, under the host's name for bash", () => {
    expect(toolLabel(call("bash", { command: "bun test\n--watch" }))).toBe("shell: bun test")
    expect(toolLabel(call("shell", { command: "git status" }))).toBe("shell: git status")
  })

  test("file and search tools read as what they touch", () => {
    expect(toolLabel(call("read", { path: "/a/b.ts" }))).toBe("read: /a/b.ts")
    expect(toolLabel(call("edit", { filePath: "/a/c.ts" }))).toBe("edit: /a/c.ts")
    expect(toolLabel(call("grep", { pattern: "TODO" }))).toBe("grep: TODO")
    expect(toolLabel(call("apply_patch", { patchText: "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch" }))).toBe(
      "patch: a.ts, b.ts",
    )
  })

  test("a tool with nothing to say about it reads as its name", () => {
    expect(toolLabel(call("todowrite", { todos: [] }))).toBe("todowrite")
    expect(toolLabel(call("kernel", { code: 42 }))).toBe("kernel")
  })

  test("a long subject is clipped to the limit with an ellipsis", () => {
    const label = toolLabel(call("shell", { command: `echo ${"x".repeat(200)}` }))
    expect(Array.from(label)).toHaveLength(LABEL_LIMIT)
    expect(label.endsWith("…")).toBe(true)
  })
})

describe("clip and firstLine", () => {
  test("clip folds control characters and whitespace into one line", () => {
    expect(clip("a\tb\n\nc\u0007d")).toBe("a b c d")
    expect(clip("abcdef", 4)).toBe("abc…")
  })

  test("firstLine skips blank lines and bare comment markers", () => {
    expect(firstLine("\n  /**\n   * Load the users\n   */")).toBe("Load the users")
    expect(firstLine("# run it")).toBe("run it")
    expect(firstLine("")).toBe("")
  })
})

describe("workingLabel", () => {
  test("nothing runs: no label", () => expect(workingLabel([], 0)).toBeUndefined())

  test("the most recently started call wins", () => {
    expect(workingLabel([call("shell", { command: "old" }, 1), call("kernel", { code: "new" }, 2)], 0)).toBe("kernel: new")
  })

  test("only subagents run: their count", () => {
    expect(workingLabel([call("task", { description: "explore" }, 5)], 1)).toBe("1 subagent")
    expect(workingLabel([], 3)).toBe("3 subagents")
  })

  test("a call and subagents: the call, then the count, always within the limit", () => {
    expect(workingLabel([call("shell", { command: "bun test" }, 1)], 2)).toBe("shell: bun test · 2 subagents")
    const label = workingLabel([call("shell", { command: "y".repeat(200) }, 1)], 12) ?? ""
    expect(Array.from(label).length).toBeLessThanOrEqual(LABEL_LIMIT)
    expect(label.endsWith(" · 12 subagents")).toBe(true)
  })
})

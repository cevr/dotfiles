// The fx-style tool group's words, from calls as OpenCode stores them.
import { describe, expect, test } from "bun:test"
import { canonical, headerRuns, rows, subject, toolRun, verb, type Call } from "../mods/prime/src/group"
import type { ToolPart } from "../mods/prime/src/view"

let ids = 0
function call(
  name: string,
  input: Record<string, unknown>,
  state: "completed" | "running" | "error" = "completed",
  metadata: Record<string, unknown> = {},
): ToolPart {
  const id = `call_${++ids}`
  const time = { created: 0, ...(state === "running" ? {} : { completed: 1 }) }
  if (state === "running") return { type: "tool", id, name, time, state: { status: "running", input } } as unknown as ToolPart
  if (state === "error")
    return {
      type: "tool",
      id,
      name,
      time,
      state: { status: "error", input, error: { type: "tool.error", message: "File not found: x.md" } },
    } as unknown as ToolPart
  return { type: "tool", id, name, time, state: { status: "completed", input, content: [], metadata } } as unknown as ToolPart
}
const calls = (...parts: ToolPart[]): Call[] => parts.map((part) => ({ tool: canonical(part.name), part }))
const words = (list: Call[]) => headerRuns(list).map((run) => run.text).join("")
const edit = (path: string, additions: number, deletions: number) =>
  call("apply_patch", { patchText: "" }, "completed", { files: [{ relativePath: path, patch: "", additions, deletions }] })

describe("the group header", () => {
  test("names each kind once, the largest count first, capitalising only the first phrase", () => {
    const list = calls(
      call("bash", { command: "ls" }),
      call("read", { path: "a.ts" }),
      call("read", { path: "b.ts" }),
      call("read", { path: "c.ts" }),
      call("bash", { command: "pwd" }),
      call("grep", { pattern: "TODO" }),
      edit("a.ts", 1, 1),
    )
    expect(words(list)).toBe("Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file")
  })

  test("puts the kinds still running last, in the running tense", () => {
    expect(words(calls(call("read", { path: "a.ts" }), call("bash", { command: "sleep 20" }, "running")))).toBe(
      "Read 1 file · running 1 command",
    )
  })

  test("ends with the failures, drawn in the error tone; a failed call still counts in its kind", () => {
    const runs = headerRuns(calls(call("read", { path: "a.ts" }), call("read", { path: "x.md" }, "error")))
    expect(runs.map((run) => run.text).join("")).toBe("Read 2 files · 1 failed")
    expect(runs.at(-1)).toEqual({ text: "1 failed", tone: "error" })
  })

  test("counts an edit's files, and names an unknown tool by its id", () => {
    expect(words(calls(call("apply_patch", { patchText: "" }, "completed", { files: [{ relativePath: "a", patch: "" }, { relativePath: "b", patch: "" }] })))).toBe(
      "Edited 2 files",
    )
    expect(words(calls(call("todowrite", {}), call("todowrite", {})))).toBe("todowrite 2×")
  })
})

describe("the tree rows", () => {
  test("fold calls to one tool with one outcome; a failure and a nonzero exit stand alone", () => {
    const list = calls(
      call("read", { path: "a.ts" }),
      call("read", { path: "b.ts" }),
      call("read", { path: "x.md" }, "error"),
      call("bash", { command: "pytest" }, "completed", { exit: 1 }),
      call("bash", { command: "pytest -x" }, "completed", { exit: 2 }),
    )
    const tree = rows(list)
    expect(tree.map((row) => `${verb(row)} ${subject(row)} [${row.outcome}]`)).toEqual([
      "Read a.ts, b.ts [done]",
      "Read x.md [failed]",
      "Ran pytest [warning]",
      "Ran pytest -x [warning]",
    ])
    expect(tree[0]!.owner).toBe(list[0]!.part.id)
  })

  test("a running call reads in the running tense; a subagent names its agent and task", () => {
    const tree = rows(calls(call("task", { description: "code-reviewer", prompt: "Review the diff." }, "running")))
    expect(`${verb(tree[0]!)} ${subject(tree[0]!)}`).toBe("Running code-reviewer · Review the diff.")
  })
})

test("a run is the tool calls next to each other around a call", () => {
  const [a, b, c] = [call("read", { path: "a" }), call("bash", { command: "ls" }), call("read", { path: "c" })]
  const content = [{ type: "text", text: "x" }, a, b, { type: "reasoning", text: "y" }, c] as never
  expect(toolRun(content, b.id).map((item) => item.part.id)).toEqual([a.id, b.id])
  expect(toolRun(content, c.id).map((item) => item.tool)).toEqual(["read"])
  expect(toolRun(content, "text:0")).toEqual([])
})

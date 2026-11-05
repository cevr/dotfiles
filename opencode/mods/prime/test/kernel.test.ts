// A kernel call in the transcript: drawn as the tool calls its cell made, as
// fx draws calls, and never as its code.
import { describe, expect, test } from "bun:test"
import { canonical, headerRuns, rows, subject, verb, type Call } from "../src/group"
import { expand, toolsInCode } from "../src/kernel"
import type { ToolPart } from "../src/view"

const kernel = (status: "completed" | "running" | "error", operations: unknown[] | undefined, code = "await sh(`ls`)"): ToolPart =>
  ({
    type: "tool",
    id: "call_k",
    name: "kernel",
    time: { created: 0 },
    state: {
      status,
      input: { code },
      content: [],
      ...(operations === undefined ? {} : { metadata: { operations } }),
      ...(status === "error" ? { error: { message: "TypeError: x is undefined" } } : {}),
    },
  }) as unknown as ToolPart

const op = (tool: string, input: Record<string, unknown>, status = "completed", metadata?: Record<string, unknown>) => ({
  tool,
  status,
  input,
  ...(metadata ? { metadata } : {}),
})
const drawn = (part: ToolPart): Call[] => expand({ tool: "kernel", part }, canonical)
const header = (calls: Call[]) => headerRuns(calls).map((run) => run.text).join("")
const lines = (calls: Call[]) => rows(calls).map((row) => `${verb(row)} ${subject(row)}`)

describe("a kernel call", () => {
  test("reads as the calls its cell made: fx's header and comma-joined rows, in the kernel call's slot", () => {
    const calls = drawn(
      kernel("completed", [
        op("read", { path: "a.ts" }),
        op("read", { path: "b.ts" }),
        op("bash", { command: "bun test" }, "completed", { exit: 0 }),
        op("shell", { command: "git status" }),
      ]),
    )
    expect(header(calls)).toBe("Read 2 files · ran 2 commands")
    expect(lines(calls)).toEqual(["Read a.ts, b.ts", "Ran bun test, git status"])
    expect(new Set(calls.map((call) => call.part.id))).toEqual(new Set(["call_k"]))
  })

  test("a failed tool inside the cell is the group's failure, with its reason", () => {
    const calls = drawn(kernel("completed", [op("read", { path: "a.ts" }), { ...op("read", { path: "x.md" }, "error"), error: "File not found: x.md" }]))
    expect(header(calls)).toBe("Read 2 files · 1 failed")
    expect(rows(calls).map((row) => row.outcome)).toEqual(["done", "failed"])
  })

  test("while it runs, the tool in flight runs; a cell still computing after its tools adds its own running row", () => {
    expect(header(drawn(kernel("running", [op("read", { path: "a.ts" }), op("shell", { command: "bun test" }, "running")])))).toBe(
      "Read 1 file · running 1 command",
    )
    const computing = drawn(kernel("running", [op("read", { path: "a.ts" })]))
    expect(computing.map((call) => call.tool)).toEqual(["read", "kernel"])
  })

  test("a cell that failed with no failed tool keeps its own failed row", () => {
    const calls = drawn(kernel("error", [op("read", { path: "a.ts" })]))
    expect(rows(calls).map((row) => row.outcome)).toEqual(["done", "failed"])
  })

  test("with nothing recorded it names the tools its code calls, never the code", () => {
    expect(lines(drawn(kernel("completed", undefined, "const r = await tools.read({ path })\nawait tools.shell({ command: 'ls' })")))).toEqual([
      "Ran a cell calling read, shell",
    ])
    expect(lines(drawn(kernel("completed", undefined, "console.log(await sh2(`git status`))")))).toEqual(["Ran a cell"])
    // Record-less cells side by side fold into one row: their count, and each tool once.
    const folded = [kernel("completed", undefined, "tools.shell(a)"), kernel("completed", undefined, "x"), kernel("completed", undefined, "tools.write(b); tools.shell(c)")]
    expect(lines(folded.flatMap(drawn))).toEqual(["Ran 3 cells calling shell, write"])
    expect(toolsInCode("tools.read(a); tools.read(b); xtools.no(c)")).toEqual(["read"])
  })
})

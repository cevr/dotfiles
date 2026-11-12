// A kernel call in the transcript: drawn as the tool calls its cell made, as
// fx draws calls, and never as its code.
import { describe, expect, test } from "bun:test"
import { canonical, type Call } from "./call.ts"
import { alone, headerRuns, levelNodes, rows, subject, verb } from "./group.ts"
import { cellCalls, expand, toolsInCode } from "./kernel.ts"
import type { Fields, ToolPart, ToolState } from "./session.ts"

const kernel = (
  status: "completed" | "running" | "error",
  operations: unknown[] | undefined,
  code = "await sh(`ls`)",
  description?: unknown,
): ToolPart => {
  const input: Fields = description === undefined ? { code } : { code, description }
  const metadata: Fields = operations === undefined ? {} : { operations }
  const state: ToolState =
    status === "running"
      ? { status, input, metadata }
      : status === "error"
        ? { status, input, content: [], error: { message: "TypeError: x is undefined" }, ...(operations === undefined ? {} : { metadata }) }
        : { status, input, content: [], ...(operations === undefined ? {} : { metadata }) }
  return { type: "tool", id: "call_k", name: "kernel", time: { created: 0 }, state }
}

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

  test("once the cell has ended, a tool it left running ends with it: never a row running for hours", () => {
    // An interrupted cell, or one whose kernel stopped under it, never closes its record.
    const interrupted = drawn(kernel("error", [op("shell", { command: "git push" }), op("shell", { command: "ssh box 'git pull'" }, "running")]))
    expect(header(interrupted)).toBe("Ran 2 commands · 1 failed")
    expect(rows(interrupted).map((row) => row.outcome)).toEqual(["done", "failed"])
    expect(interrupted.map((call) => call.tool)).toEqual(["shell", "shell"])
    expect(rows(drawn(kernel("completed", [op("read", { path: "a.ts" }, "running")]))).map((row) => row.outcome)).toEqual(["done"])
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

  test("a record-less cell's header counts the calls its code spells out, else says it ran code", () => {
    expect(header(drawn(kernel("completed", undefined, "await tools.read({ path })\nawait tools.read({ path: b })\nawait Bun.$`git status`")))).toBe(
      "Read 2 files · ran 1 command",
    )
    expect(header(drawn(kernel("completed", undefined, "const x = 1 + 1")))).toBe("Ran code")
    expect(header(drawn(kernel("running", undefined, "while (true) {}")))).toBe("Running code")
  })

  test("the kernel call left after its recorded calls counts as code while it computes, and only as a failure once it ends", () => {
    expect(header(drawn(kernel("running", [op("read", { path: "a.ts" })])))).toBe("Read 1 file · running code")
    expect(header(drawn(kernel("error", [op("read", { path: "a.ts" })])))).toBe("Read 1 file · 1 failed")
  })
})

describe("a kernel call's description", () => {
  const ops = [op("shell", { command: "git merge skill-dollar" }), op("shell", { command: "bun test" }), op("read", { path: "notes.md" })]

  test("is the header, in the normal text colour, over the rows the cell's calls draw", () => {
    const calls = drawn(kernel("completed", ops, "await tools.shell(a)", "Merge the skill-dollar worker"))
    expect(headerRuns(calls)).toEqual([{ text: "Merge the skill-dollar worker", tone: "base" }])
    expect(lines(calls)).toEqual(["Ran git merge skill-dollar, bun test", "Read notes.md"])
  })

  test("without one, the header counts what the cell did, as before", () => {
    const calls = drawn(kernel("completed", ops))
    expect(headerRuns(calls)).toEqual([{ text: "Ran 2 commands · read 1 file", tone: "muted" }])
    expect(calls.every((call) => call.cell === undefined)).toBe(true)
  })

  test("a blank or non-text one counts as none; a multi-line one is one line", () => {
    expect(header(drawn(kernel("completed", ops, "x", "   ")))).toBe("Ran 2 commands · read 1 file")
    expect(header(drawn(kernel("completed", ops, "x", 42)))).toBe("Ran 2 commands · read 1 file")
    expect(header(drawn(kernel("completed", ops, "x", "Merge the\n  worker ")))).toBe("Merge the worker")
  })

  test("is cut to the width, an ellipsis marking the cut, keeping the failures whole", () => {
    const failing = [op("read", { path: "a.ts" }), { ...op("read", { path: "x.md" }, "error"), error: "File not found: x.md" }]
    const runs = headerRuns(drawn(kernel("completed", failing, "x", "Merge the skill-dollar worker")), 20)
    expect(runs.map((run) => run.text)).toEqual(["Merge th…", " · ", "1 failed"])
    expect(runs.map((run) => run.text).join("")).toHaveLength(20)
    expect(runs.map((run) => run.tone)).toEqual(["base", "muted", "error"])
  })

  test("heads even a group of one row; without one, that row is the group's line alone", () => {
    const one = [op("shell", { command: "git merge skill-dollar" })]
    const described = drawn(kernel("completed", one, "x", "Merge the skill-dollar worker"))
    const nodes = (calls: Call[]) => levelNodes(calls.map((call) => ({ type: "call" as const, call })), "details")
    expect(alone(described, nodes(described), "details")).toBe(false)
    const plain = drawn(kernel("completed", one))
    expect(alone(plain, nodes(plain), "details")).toBe(true)
    // A cell that recorded nothing still has its description over its own row.
    const bare = drawn(kernel("completed", undefined, "const x = 1", "Count the lines"))
    expect(header(bare)).toBe("Count the lines")
    expect(lines(bare)).toEqual(["Ran a cell"])
  })
})

describe("the calls a cell's code spells out", () => {
  test("tools by name and by key, Bun's shell, spawn, files, globs and fetches, in source order", () => {
    const code = [
      'const t = await tools["web-search"]({ q })',
      "await Bun.$`git log --oneline -5 | head`",
      'Bun.spawn(["bun", "test", "--watch"])',
      'const text = await Bun.file("src/a.ts").text()',
      'await Bun.write("out.txt", text)',
      'new Bun.Glob("**/*.ts")',
      'await fetch("https://example.com/x")',
      "await tools.edit({ path })",
    ].join("\n")
    expect(cellCalls(code)).toEqual([
      { tool: "web-search", detail: "" },
      { tool: "shell", detail: "git log --oneline" },
      { tool: "shell", detail: "bun test --watch" },
      { tool: "read", detail: "src/a.ts" },
      { tool: "write", detail: "out.txt" },
      { tool: "glob", detail: "**/*.ts" },
      { tool: "webfetch", detail: "https://example.com/x" },
      { tool: "edit", detail: "" },
    ])
    expect(cellCalls("const sh = (x) => x; xtools.no(1)")).toEqual([])
  })
})

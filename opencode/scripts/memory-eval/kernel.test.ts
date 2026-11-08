// The kernel arm with no API call: its description is the real one over the
// real catalog, and a cell reaches the fake world and our memory through
// `tools`, with bindings that persist from cell to cell.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalog as FIXTURE } from "../../mods/kernel/catalog.fixture.ts"
import { catalogLines, type Dispatch, kernelTool, listingOf, newKernel } from "./kernel.ts"
import { ours } from "./memory.ts"
import { SCENARIOS } from "./scenarios.ts"
import type { ToolDef } from "./tools.ts"
import { newWorld, runDistractor, runShell } from "./world.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-eval-kernel-"))
  dirs.push(dir)
  const memory = await ours(dir)
  const tools = memory.tools as ReadonlyArray<ToolDef>
  const s = SCENARIOS.find((scenario) => scenario.id === "webapp")!
  const world = newWorld(s.cwd, s.files, "main", s.noise)
  const calls: Array<string> = []
  const dispatch: Dispatch = (name, input) => {
    calls.push(name)
    if (memory.names.has(name)) return memory.call("session-1", name, input).then((answer) => ({ output: answer.text, error: answer.error }))
    const outcome = name === "shell" ? runShell(String(input["command"]), world, s.rules) : runDistractor(name, input, world)
    return { output: outcome.out, error: outcome.code !== 0 }
  }
  return { memory, tools, kernel: newKernel(listingOf(tools), s.cwd), dispatch, calls }
}

describe("the kernel arm", () => {
  test("lists the real 50-tool catalog, memory as one line each, in the production format", async () => {
    const { memory, tools } = await setup()
    try {
      const lines = catalogLines(tools)
      expect(lines).toHaveLength(FIXTURE.length)
      expect(lines.filter((line) => line.startsWith("- tools.memory_"))).toHaveLength(3)
      expect(lines.find((line) => line.startsWith("- tools.memory_save("))).toStartWith("- tools.memory_save(input: { text: string, scope?: ")
      expect(lines.find((line) => line.startsWith("- tools.memory_save("))).toEndWith("): Save a note to long-term memory, kept on this machine across sessions.")
      expect(lines.find((line) => line.startsWith("- tools.read("))).toBe("- tools.read(input: { path: string, offset?: number, limit?: number }): Read the contents of a file or directory.")
      const tool = kernelTool(tools)
      expect(tool.description).toStartWith("Run TypeScript in a persistent kernel")
      expect(tool.description).toContain("the kernel is your only tool")
      expect(tool.description).toEndWith(lines.join("\n"))
    } finally {
      await memory.close()
    }
  })

  test("a cell runs the fake shell and saves a note, tags given as a string; bindings persist", async () => {
    const { memory, kernel, dispatch, calls } = await setup()
    try {
      const first = await kernel.run(
        `const h = await tools.shell({ command: "git status" })\nconst saved: string = await tools.memory_save({ text: "acme-web: run tests with TEST_ENV=unit", tags: "tests, ci" })\nconsole.log(h.exitCode)\nsaved`,
        dispatch,
      )
      expect(first).toEqual({ ok: true, text: "0\nSaved #1 (project)." })
      expect(await kernel.run("h.output.length > 0", dispatch)).toEqual({ ok: true, text: "true" })
      expect(calls).toEqual(["shell", "memory_save"])
      expect(memory.stored().units).toEqual(["acme-web: run tests with TEST_ENV=unit tests ci"])
    } finally {
      await memory.close()
    }
  })

  test("child_process, fs and Bun reach the fake world as shell, read and write calls", async () => {
    const { memory, kernel, dispatch, calls } = await setup()
    try {
      const listed = await kernel.run(`import { execSync } from "child_process"\nexecSync("git branch --show-current").toString().trim()`, dispatch)
      expect(listed.text).toContain("main")
      const failed = await kernel.run(`require("node:child_process").execSync("npm test src/lib/slug.test.ts")`, dispatch)
      expect(failed.ok).toBe(false)
      expect(failed.text).toContain("Command failed: npm test src/lib/slug.test.ts")
      const read = await kernel.run(`const fs = require("fs")\nfs.readFileSync("src/lib/format.ts", "utf8").split("\\n")[0]`, dispatch)
      expect(read.text).toBe("export function formatPrice(cents: number): string {")
      expect((await kernel.run("(await Bun.$`git status`.text()).length > 0", dispatch)).text).toBe("true")
      await kernel.run(`await Bun.write("notes.txt", "x")`, dispatch)
      expect(calls).toEqual(["shell", "shell", "read", "shell", "write"])
    } finally {
      await memory.close()
    }
  })

  test("a refused call throws into the cell; docs and an unavailable tool answer as the worker does", async () => {
    const { memory, kernel, dispatch } = await setup()
    try {
      const empty = await kernel.run(`await tools.memory_save({ text: "" })`, dispatch)
      expect(empty).toEqual({ ok: false, text: "Error: The note is empty: write the fact to keep." })
      expect((await kernel.run(`tools.docs("memory_save").description`, dispatch)).text).toStartWith("Save a note to long-term memory")
      expect((await kernel.run(`tools.docs.search("remember a note")[0].name`, dispatch)).text).toStartWith("memory_")
      expect(await kernel.run(`await tools.rift({ action: "list" })`, dispatch)).toEqual({ ok: false, text: "Error: rift is unavailable in this session" })
      expect((await kernel.run(`tools.nope`, dispatch)).text).toStartWith("Error: tools.nope is not a tool here.")
      expect(await kernel.run(`void 0`, dispatch)).toEqual({ ok: true, text: "(no output)" })
    } finally {
      await memory.close()
    }
  })
})

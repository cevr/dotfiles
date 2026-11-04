// The kernel in real OpenCode (the fork, through its SDK) on the scripted
// model: two kernel calls in one session share a binding, the first reads a
// file through `tools.read`, and `denyExecute` keeps code mode's `execute` from
// the model. The kernel on its own is mods/kernel/test.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./kernel/run.ts"
import { cells, DONE, HELLO, KERNEL_TASK } from "./kernel/sim.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/kernel.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "kernel-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/kernel/run.ts. */
const run = async (name: string, spec: Pick<Spec, "task" | "denyExecute">): Promise<Result & { base: string }> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ ...spec, base, fork: resolve(fork!), plugin: join(ROOT, "mods/kernel") } satisfies Spec))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "kernel/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result))
    throw new Error(`the ${name} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return { ...(JSON.parse(readFileSync(result, "utf8")) as Result), base }
}

interface ToolPart {
  readonly type: "tool"
  readonly name: string
  readonly state: { readonly status: string; readonly input: { readonly code?: string }; readonly content?: ReadonlyArray<{ readonly text?: string }> }
}
const toolParts = (messages: unknown): ToolPart[] =>
  (messages as Array<{ type: string; content?: Array<{ type: string }> }>)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part): part is ToolPart => part.type === "tool")

const RUN_MS = 150_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "two kernel calls share a binding; the first reads a work-dir file through tools.read; execute is not offered",
    async () => {
      const result = await run("kernel", { task: KERNEL_TASK, denyExecute: true })
      const calls = toolParts(result.messages)
      const file = join(result.base, "work/hello.txt")
      expect(calls.map((call) => ({ name: call.name, status: call.state.status, code: call.state.input.code }))).toEqual(
        cells(file).map((code) => ({ name: "kernel", status: "completed", code })),
      )
      const texts = calls.map((call) => (call.state.content ?? []).map((part) => part.text ?? "").join(""))
      // The first call printed what tools.read returned, then the value of note.length.
      expect(texts[0]).toContain(JSON.stringify(`${HELLO}\n`))
      expect(texts[0]!.endsWith("\n4")).toBe(true)
      // The second call read the binding the first one made.
      expect(texts[1]).toBe("kept!")
      // The model saw both results and finished.
      const turns = result.seen.filter((request) => request.task === KERNEL_TASK)
      expect(turns.map((request) => request.last).slice(1)).toEqual(texts)
      expect(JSON.stringify(result.messages)).toContain(DONE)
      // denyExecute: the kernel is the only code tool, and the others are offered directly.
      for (const request of turns) {
        expect(request.tools).toContain("kernel")
        expect(request.tools).toContain("read")
        expect(request.tools).not.toContain("execute")
      }
    },
    RUN_MS,
  )

  test(
    "without denyExecute, code mode's execute is offered beside the kernel",
    async () => {
      const result = await run("execute", { task: "plain", denyExecute: false })
      const request = result.seen.find((item) => item.task === "plain")!
      expect(request.tools).toContain("kernel")
      expect(request.tools).toContain("execute")
    },
    RUN_MS,
  )
})

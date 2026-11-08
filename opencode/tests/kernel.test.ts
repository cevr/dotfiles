// The kernel in real OpenCode (the fork, through its SDK) on the scripted
// model: two kernel calls in one session share a binding, the first reads a
// file through `tools.read`, `denyExecute` keeps code mode's `execute` from
// the model, and an image a cell attaches reaches the next request. The kernel on its own is tested beside its code in mods/kernel.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./kernel/run.ts"
import { ATTACH_CELL, ATTACH_TASK, cells, DONE, HELLO, KERNEL_TASK, SUBAGENT_TASK } from "./kernel/sim.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/kernel.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "kernel-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/kernel/run.ts. */
const run = async (name: string, spec: Pick<Spec, "task" | "denyExecute" | "codeOnly" | "orchestrate" | "images">): Promise<Result & { base: string }> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ ...spec, base, fork: resolve(fork!), plugin: join(ROOT, "cmd/kernel") } satisfies Spec))
  const child = owned([process.execPath, join(import.meta.dir, "kernel/run.ts"), file], {
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
  readonly state: {
    readonly status: string
    readonly input: { readonly code?: string }
    readonly content?: ReadonlyArray<{ readonly text?: string }>
    readonly metadata?: { readonly operations?: ReadonlyArray<{ readonly tool: string; readonly status: string; readonly input: Record<string, unknown> }> }
  }
}
const toolParts = (messages: unknown): ToolPart[] =>
  (messages as Array<{ type: string; content?: Array<{ type: string }> }>)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part): part is ToolPart => part.type === "tool")

const RUN_MS = 150_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "code only: the kernel is the one tool offered; two calls share a binding, the first reads a work-dir file through tools.read",
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
      // Each call keeps the tools its cell called, for the transcript: the read, and nothing for the second.
      expect(calls[0]!.state.metadata?.operations?.map(({ tool, status, input }) => ({ tool, status, input }))).toEqual([
        { tool: "read", status: "completed", input: { path: file } },
      ])
      expect(calls[1]!.state.metadata?.operations).toBeUndefined()
      // The model saw both results and finished.
      const turns = result.seen.filter((request) => request.task === KERNEL_TASK)
      expect(turns.map((request) => request.last).slice(1)).toEqual(texts)
      expect(JSON.stringify(result.messages)).toContain(DONE)
      // The kernel is the runtime: no other tool is offered, and its description lists them with their input.
      for (const request of turns) expect(request.tools).toEqual(["kernel"])
      expect(turns[0]!.kernel).toContain("- tools.read(input: { ")
      expect(turns[0]!.kernel).toContain("- tools.subagent(input: { ")
    },
    RUN_MS,
  )

  test(
    "a cell attaches a PNG; the next model request carries it as an image",
    async () => {
      const result = await run("attach", { task: ATTACH_TASK, denyExecute: true, images: true })
      const [cell] = toolParts(result.messages)
      expect({ code: cell?.state.input.code, status: cell?.state.status }).toEqual({ code: ATTACH_CELL, status: "completed" })
      expect((cell?.state.content ?? []).map((part) => part.text ?? "").join("")).toBe("attached 1 image: pixel.png")
      const [first, next] = result.seen.filter((request) => request.task === ATTACH_TASK)
      expect(first?.images).toBeUndefined()
      // The host's normalizer may re-encode the pixel, so the request carries a PNG data URI, not these bytes.
      expect(next?.images).toHaveLength(1)
      expect(next?.images?.[0]).toStartWith("data:image/png;base64,")
    },
    RUN_MS,
  )

  test(
    "without codeOnly the kernel sits beside the direct tools; denyExecute decides whether execute is offered",
    async () => {
      const denied = await run("direct", { task: "plain", denyExecute: true, codeOnly: false })
      const direct = denied.seen.find((item) => item.task === "plain")!
      expect(direct.tools).toContain("kernel")
      expect(direct.tools).toContain("read")
      expect(direct.tools).not.toContain("execute")
      const result = await run("execute", { task: "plain", denyExecute: false, codeOnly: false })
      const request = result.seen.find((item) => item.task === "plain")!
      expect(request.tools).toContain("kernel")
      expect(request.tools).toContain("execute")
    },
    RUN_MS,
  )

  test(
    "a cell's tools.subagent runs through the orchestrate hooks: refused in the Sabbath, started on a weekday",
    async () => {
      const result = await run("subagent", {
        task: SUBAGENT_TASK,
        denyExecute: true,
        orchestrate: { plugin: join(ROOT, "cmd/orchestrate"), now: "2026-10-30T23:00:00Z" },
      })
      const [cell] = toolParts(result.messages)
      const text = (cell!.state.content ?? []).map((part) => part.text ?? "").join("")
      expect(text).toMatch(/^refused: It is the Sabbath; agent work resumes at Sat 18:\d\d/)
      expect(text).toContain("No agent starts now.")
      // The guard logged the refused call under the kernel call's id.
      const log = readFileSync(join(result.base, "agents.jsonl"), "utf8")
      expect(log).toContain('"kind":"denied"')
      expect(log).toContain('"tool":"subagent"')
      // On a weekday the same cell starts the worker, which the guard logs.
      const weekday = await run("subagent-weekday", {
        task: SUBAGENT_TASK,
        denyExecute: true,
        orchestrate: { plugin: join(ROOT, "cmd/orchestrate"), now: "2026-11-04T15:00:00Z" },
      })
      const [started] = toolParts(weekday.messages)
      expect((started!.state.content ?? []).map((part) => part.text ?? "").join("")).toBe("started")
      const calls = readFileSync(join(weekday.base, "agents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; agent?: string; status?: string })
      expect(calls.filter((call) => call.kind === "call").map((call) => call.agent)).toEqual(["worker"])
      expect(calls.filter((call) => call.kind === "done").map((call) => call.status)).toEqual(["completed"])
    },
    RUN_MS,
  )
})

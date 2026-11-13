// The kernel in real OpenCode (the fork, through its SDK) on the scripted
// model: two kernel calls in one session share a binding, the first reads a
// file through `tools.read`, `denyExecute` keeps code mode's `execute` from
// the model, an image a cell attaches reaches the next request, and with the
// memory mod loaded its tools are offered beside the kernel and called directly, and a cell's
// shell handle keeps a command's output through a wait, and a cell's subagent
// handle stops a real child mid-turn (its parent hears it cancelled once) and
// is refused a session that is no descendant. The kernel on its own is tested beside its code in mods/kernel.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import type { Result, Spec } from "./kernel/run.ts"
import { ATTACH_CELL, ATTACH_TASK, cells, DONE, DROP_TASK, HELLO, KERNEL_TASK, MEMORY_TASK, QUEUED_PROMPT, SELF, SHELL_TASK, STALL_TASK, STOP_TASK, SUBAGENT_TASK } from "./kernel/sim.ts"
import { owned } from "./owned.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/kernel.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = scratchDir("kernel-e2e-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/kernel/run.ts. `check` reads its result before it is returned. */
const run = async (
  name: string,
  spec: Pick<Spec, "task" | "denyExecute" | "codeOnly" | "orchestrate" | "memory" | "images">,
  check: (result: Result & { base: string }) => void = () => {},
): Promise<Result & { base: string }> => {
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
  const ran = { ...(JSON.parse(readFileSync(result, "utf8")) as Result), base }
  check(ran)
  return ran
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

/** The drop run's cell wrote alpha's move to dropped, and the root's ledger ended alpha once (its `UnitDropped`). */
const droppedAlpha = (result: Result & { base: string }) => {
  const [cell] = toolParts(result.messages)
  expect((cell!.state.content ?? []).map((part) => part.text ?? "").join("")).toMatch(/implement → dropped r1 superseded/)
  const dropped = readFileSync(join(result.base, "machine.jsonl"), "utf8").split("\n").filter((entry) => entry.includes('"kind":"UnitDropped"'))
  expect(dropped).toHaveLength(1)
  expect(dropped[0]).toContain('"unit":"alpha"')
}

/** A message of the session's context that carries text, as a `<subagent>` notice is one. */
const Notice = Schema.Struct({ type: Schema.Literal("synthetic"), text: Schema.String })
const noticesOf = (result: Result) => Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(result.messages).filter(Schema.is(Notice)).map((notice) => notice.text)

/**
 * The stop run: the cell saw its child (mid-turn, its background shell running, a prompt queued behind it) running
 * past a short wait, stopped once and then unchanged, still stopped after the time its shell would have ended, the
 * shell's file never written, and a stop of its own session refused. The parent heard one cancelled notice and none
 * of a finish; the child asked the model only for its shell and its stalled turn, never with the queued prompt, which
 * no longer waits in its inbox.
 */
const stoppedChild = (result: Result) => {
  const [cell] = toolParts(result.messages)
  expect(cell?.state.status).toBe("completed")
  expect((cell?.state.content ?? []).map((part) => part.text ?? "").join("")).toMatch(
    /^waited: running, still running after 3000 ms\nstopped: stopped, stopped\nagain: stopped, it was not running \(stopped\)\nlater: stopped\nlate file: none\nother: .*ses_\w+ is not a subagent of this session: a session reaches only its own subagents\.$/,
  )
  const notices = noticesOf(result).filter((text) => text.startsWith("<subagent "))
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('state="cancelled"')
  // The child's model requests are its shell's call and its stalled turn: nothing ran it again after the stop.
  expect(result.seen.filter((request) => request.task.endsWith(STALL_TASK) && request.tools.length > 0)).toHaveLength(2)
  expect(result.seen.filter((request) => request.last.includes(QUEUED_PROMPT))).toEqual([])
  // The run queued a prompt behind the child's stalled turn; the stop dropped it, so no prompt waits in its inbox.
  expect(result.inbox).not.toContainEqual(expect.objectContaining({ type: "user" }))
}

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
    "a cell's shell handle shows a command's output: on the run, and on a wait that sees the end",
    async () => {
      const result = await run("shell", { task: SHELL_TASK, denyExecute: true })
      const [cell] = toolParts(result.messages)
      expect(cell?.state.status).toBe("completed")
      const text = (cell?.state.content ?? []).map((part) => part.text ?? "").join("")
      // The cell's last value is the JSON of what each handle's output was after each call.
      const seen = JSON.parse(text) as Record<string, string>
      expect(seen).toEqual({
        // A foreground command ended within the call: its handle carries the output, and a wait or a refresh after
        // it, which see nothing new, keep it.
        fgRun: "fg-out\n",
        fgWait: "fg-out\n",
        fgRefresh: "fg-out\n",
        chained: "chained\n",
        // A background command: nothing yet at the start, all of it once a wait sees the end.
        bgRun: "",
        bgWait: "bg-out\n",
        quickWait: "quick\n",
        // A foreground command moved to the background at its limit: the output the run showed stays in front of
        // what the wait adds.
        bothRun: "first\n",
        bothWait: "first\nlast\n",
      })
    },
    RUN_MS,
  )

  test(
    "code only with the memory mod: the memory tools are offered beside the kernel, off its list, and a direct memory_save saves",
    async () => {
      const result = await run("memory", { task: MEMORY_TASK, denyExecute: true, memory: { plugin: join(ROOT, "cmd/memory") } })
      const turns = result.seen.filter((request) => request.task === MEMORY_TASK)
      expect(turns.length).toBe(2)
      // The same tools on every request of the session, so the cached prefix holds.
      for (const request of turns) expect([...request.tools].sort()).toEqual(["kernel", "memory_forget", "memory_save", "memory_search"])
      expect(turns[0]!.kernel).toContain("the kernel is your main tool")
      expect(turns[0]!.kernel).toContain("- tools.read(input: { ")
      expect(turns[0]!.kernel).not.toContain("tools.memory_")
      const [saved] = toolParts(result.messages)
      expect({ name: saved?.name, status: saved?.state.status }).toEqual({ name: "memory_save", status: "completed" })
      expect((saved?.state.content ?? []).map((part) => part.text ?? "").join("")).toBe("Saved #1 (global).")
      expect(JSON.stringify(result.messages)).toContain(DONE)
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
      // OpenCode runs every subagent in the background: the call ends as the worker starts, so it logs `running`.
      expect(calls.filter((call) => call.kind === "done").map((call) => call.status)).toEqual(["running"])
    },
    RUN_MS,
  )

  test(
    "a cell's subagent handle stops a real child mid-turn: it reads stopped, the parent hears one cancelled notice and no completion, and a stop of a session that is no descendant (its own) is refused",
    () =>
      run("stop", { task: `${SELF}\n${STOP_TASK}`, denyExecute: true, orchestrate: { plugin: join(ROOT, "cmd/orchestrate"), now: "2026-11-04T15:00:00Z" } }, stoppedChild),
    RUN_MS,
  )

  test(
    "a cell's tools.shell that drops a unit by log.ts runs through the orchestrate after hook: the unit ends on the root's ledger",
    () => {
      // alpha's log made and moved to dropped by the skill's log.ts, relative to the root's directory.
      const log = `bun ${join(ROOT, "../skills/orchestrate/scripts/log.ts")}`
      const line = `mkdir -p run/alpha && ${log} run/alpha new implement r1 && ${log} run/alpha implement dropped r1 superseded`
      return run("drop", { task: `${line}\n${DROP_TASK}`, denyExecute: true, orchestrate: { plugin: join(ROOT, "cmd/orchestrate"), now: "2026-11-04T15:00:00Z" } }, droppedAlpha)
    },
    RUN_MS,
  )
})

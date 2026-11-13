// accept: deep (56.4 s alone on a quiet host: 1-minute load 9.8–12.8 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// The guard in real OpenCode (the fork, through its SDK) on the scripted
// model, beside the kernel: what only the real host proves. The guard's
// decisions (what is refused in which words, what reaches the shell and with
// which program, a subagent's long sleep) run on the simulated host in
// cmd/guard/guard.sim.test.ts and guard-faults.sim.test.ts, and
// tests/parity/hooks.json says which name went where. Here: a kernel cell
// cannot reach the shell unless the kernel is the runtime, and as the runtime
// its `tools.shell` call goes through the guard (the kernel runs in a Bun
// worker the world does not model); the work repository's HEAD and dirty file
// stay as they were on disk; a session the fork's subagent tool starts is a
// subagent to the guard; a heavy command's launcher is a file on disk that
// really runs it niced; the host's own `ps` shows the server a kill by
// pattern would hit. Every shell call runs in a git repository the run makes
// in a scratch dir. The guard on its own is tested beside its code in
// mods/guard and cmd/guard.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { getPriority } from "node:os"
import { join, resolve } from "node:path"
import { DIRTY, git, KEPT_FILE } from "./guard/repo.ts"
import type { Result, Spec } from "./guard/run.ts"
import { CELL_TASK, CHILD_SLEEP, DIRECT_TASK, DONE, HARMLESS_FILE, HARMLESS_OUT, HEAVY_NICE, killByPattern, LIGHT_NICE, POLICY_TASK, SLEEP_TASK } from "./guard/sim.ts"
import { owned } from "./owned.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/guard.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = scratchDir("guard-e2e-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/guard/run.ts. */
const run = async (name: string, spec: Pick<Spec, "task" | "codeOnly">): Promise<Result & { work: string }> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(
    file,
    JSON.stringify({ ...spec, base, fork: resolve(fork ?? ""), kernel: join(ROOT, "cmd/kernel"), guard: join(ROOT, "cmd/guard") } satisfies Spec),
  )
  const child = owned([process.execPath, join(import.meta.dir, "guard/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the ${name} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return { ...(JSON.parse(readFileSync(result, "utf8")) as Result), work: join(base, "work") }
}

interface ToolPart {
  readonly type: "tool"
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input: Record<string, unknown>
    readonly content?: ReadonlyArray<{ readonly text?: string }>
    readonly error?: unknown
  }
}
const toolParts = (messages: unknown): ToolPart[] =>
  (messages as Array<{ type: string; content?: Array<{ type: string }> }>)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part): part is ToolPart => part.type === "tool")

/** Everything a tool part says: its content's text and its error. */
const said = (part: ToolPart | undefined): string =>
  part === undefined
    ? ""
    : [...(part.state.content ?? []).map((item) => item.text ?? ""), ...(part.state.error === undefined ? [] : [JSON.stringify(part.state.error)])].join("\n")

/** The niceness a shell call printed: the last line of its output, after the shell tool's status line. */
const niceness = (part: ToolPart | undefined): number => Number(said(part).trim().split("\n").at(-1))

const REFUSAL = "guard-destructive: `git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first."

/** The work repository is as the run left it before the prompt, and the harmless command ran in it. */
const untouched = (result: Result & { work: string }) => {
  expect(git(result.work, "rev-parse", "HEAD")).toBe(result.head)
  expect(readFileSync(join(result.work, KEPT_FILE), "utf8")).toBe(DIRTY)
  expect(readFileSync(join(result.work, HARMLESS_FILE), "utf8")).toBe(`${HARMLESS_OUT}\n`)
}

const RUN_MS = 150_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  // Real alone: the kernel's cell runs in a Bun worker, and the repository is on disk. The direct call's refusal and
  // that the reset never reaches the shell are simulated (cmd/guard/guard.sim.test.ts, the direct case).
  test(
    "while the kernel is not the runtime, a cell cannot reach the shell, and after a refused reset the work repository keeps its HEAD and dirty file",
    async () => {
      const result = await run("direct", { task: DIRECT_TASK, codeOnly: false })
      const cell = toolParts(result.messages).find((part) => part.name === "kernel")
      // Without the runtime a cell's call would skip the guard's hook, so the kernel keeps the shell from it.
      expect(said(cell)).toContain("refused: tools.shell is not a tool here.")
      untouched(result)
    },
    RUN_MS,
  )

  // Real alone: the fork's subagent tool makes the child session, and the guard must know it as a subagent from what
  // OpenCode says of it. The refusal's words and the root's sleep are simulated on a child session the world makes
  // (cmd/guard/guard.sim.test.ts, the sleep case).
  test(
    "a session the subagent tool starts is a subagent to the guard: its shell call opening with sleep 60 is refused",
    async () => {
      const result = await run("sleep", { task: SLEEP_TASK, codeOnly: false })
      const subagent = toolParts(result.messages).find((part) => part.name === "subagent")
      expect(subagent?.state.status).toBe("completed")
      const children = Object.values(result.children)
      expect(children).toHaveLength(1)
      const childSleep = toolParts(children[0]).find((part) => part.state.input.command === CHILD_SLEEP)
      expect(childSleep?.state.status).toBe("error")
      expect(said(childSleep)).toContain("guard-sleep: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
    },
    RUN_MS,
  )

  // Real alone: the niceness a process runs at, the launcher file on disk, and the host's own process table (`ps`)
  // listing the server. Which program each command spawns with and the launcher's text are simulated
  // (cmd/guard/guard.sim.test.ts, the policy case).
  test(
    "a heavy command's launcher is a file on disk named as the shell, and runs it 10 nicer than a light one; the real process table shows the server a kill by pattern would hit",
    async () => {
      const result = await run("policy", { task: POLICY_TASK, codeOnly: false })
      const parts = toolParts(result.messages)
      const heavy = parts.find((part) => part.state.input.command === HEAVY_NICE)
      const light = parts.find((part) => part.state.input.command === LIGHT_NICE)
      const kill = parts.find((part) => part.state.input.command === killByPattern(join(scratch, "policy/spec.json")))
      expect(kill?.state.status).toBe("error")
      expect(said(kill)).toContain("would also kill the OpenCode server this session runs on")
      // The run's process, and so OpenCode's shells, start at this test's niceness; the guard adds 10, up to the
      // system's highest niceness (20 on macOS, 19 on Linux).
      const base = getPriority()
      expect(niceness(light)).toBe(base)
      expect(niceness(heavy)).toBe(Math.min(base + 10, process.platform === "darwin" ? 20 : 19))
      const launchers = join(scratch, "policy/home/.cache/opencode/guard-launchers")
      // One launcher, named as the shell it stands in for, so OpenCode reads the command in that shell's dialect.
      const written = readdirSync(launchers).flatMap((hash) => readdirSync(join(launchers, hash)))
      expect(written).toHaveLength(1)
      expect(written[0]).toMatch(/^(ba|z|da|k)?sh$/)
    },
    RUN_MS,
  )

  test(
    "a kernel cell's tools.shell call of git reset --hard is refused in the guard's words, and its harmless command runs",
    async () => {
      const result = await run("cell", { task: CELL_TASK, codeOnly: true })
      expect(result.seen.find((item) => item.task === CELL_TASK)?.tools).toEqual(["kernel"])
      const [cell, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(cell?.name).toBe("kernel")
      const lines = said(cell).split("\n")
      expect(lines[0]).toBe(`refused: ${REFUSAL}`)
      expect(lines[1]).toStartWith("ran: ")
      expect(lines[1]).toContain(HARMLESS_OUT)
      untouched(result)
      expect(JSON.stringify(result.messages)).toContain(DONE)
    },
    RUN_MS,
  )
})

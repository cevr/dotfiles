// The guard in real OpenCode (the fork, through its SDK) on the scripted
// model, beside the kernel. `git reset --hard` is refused as a direct shell
// call and as a kernel cell's `tools.shell` call; the work repository's HEAD
// and its dirty file stay as they were, and a harmless command still runs.
// Every shell call runs in a git repository the run makes in a scratch dir.
// The guard on its own is tested beside its code in mods/guard and cmd/guard.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DIRTY, git, KEPT_FILE } from "./guard/repo.ts"
import type { Result, Spec } from "./guard/run.ts"
import { CELL_TASK, CHILD_SLEEP, DIRECT_TASK, DONE, HARMLESS, HARMLESS_FILE, HARMLESS_OUT, RESET, ROOT_SLEEP, SLEEP_TASK } from "./guard/sim.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/guard.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "guard-e2e-"))
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
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "guard/run.ts"), file], {
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

const REFUSAL = "guard-destructive: `git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first."

/** The work repository is as the run left it before the prompt, and the harmless command ran in it. */
const untouched = (result: Result & { work: string }) => {
  expect(git(result.work, "rev-parse", "HEAD")).toBe(result.head)
  expect(readFileSync(join(result.work, KEPT_FILE), "utf8")).toBe(DIRTY)
  expect(readFileSync(join(result.work, HARMLESS_FILE), "utf8")).toBe(`${HARMLESS_OUT}\n`)
}

const RUN_MS = 150_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "a direct shell call of git reset --hard is refused in the guard's words, a cell cannot reach the shell, and a harmless command runs",
    async () => {
      const result = await run("direct", { task: DIRECT_TASK, codeOnly: false })
      expect(result.seen.find((item) => item.task === DIRECT_TASK)?.tools).toContain("shell")
      const [reset, cell, harmless, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(reset?.name).toBe("shell")
      expect(reset?.state.input.command).toBe(RESET)
      expect(reset?.state.status).toBe("error")
      expect(said(reset)).toContain(REFUSAL)
      // Without the runtime a cell's call would skip the guard's hook, so the kernel keeps the shell from it.
      expect(cell?.name).toBe("kernel")
      expect(said(cell)).toContain("refused: tools.shell is not a tool here.")
      expect(harmless?.name).toBe("shell")
      expect(harmless?.state.input.command).toBe(HARMLESS)
      expect(harmless?.state.status).toBe("completed")
      expect(said(harmless)).toContain(HARMLESS_OUT)
      untouched(result)
    },
    RUN_MS,
  )

  test(
    "a subagent's shell call opening with sleep 60 is refused in the guard's words, and the root's sleep runs",
    async () => {
      const result = await run("sleep", { task: SLEEP_TASK, codeOnly: false })
      const [subagent, rootSleep, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(subagent?.name).toBe("subagent")
      expect(subagent?.state.status).toBe("completed")
      expect(rootSleep?.name).toBe("shell")
      expect(rootSleep?.state.input.command).toBe(ROOT_SLEEP)
      expect(rootSleep?.state.status).toBe("completed")
      expect(said(rootSleep)).not.toContain("guard-sleep")
      const children = Object.values(result.children)
      expect(children).toHaveLength(1)
      const [childSleep, ...childRest] = toolParts(children[0])
      expect(childRest).toEqual([])
      expect(childSleep?.name).toBe("shell")
      expect(childSleep?.state.input.command).toBe(CHILD_SLEEP)
      expect(childSleep?.state.status).toBe("error")
      expect(said(childSleep)).toContain("guard-sleep: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
      expect(said(childSleep)).toContain("wait\\\", id, ms })")
      expect(said(childSleep)).not.toContain("child slept")
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

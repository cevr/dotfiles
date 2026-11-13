// The memory plugin in real OpenCode (the fork, through its SDK) on the
// scripted model, on a scratch memory file. A run sends an id, a limit and
// tags as strings, as models do, and they are read as the number and the list
// (decider/tool-input.ts); a word for an id is refused in the host's words.
// The save, repeat, search, digest and CLI run moved to the simulated host
// (cmd/memory/memory.sim.test.ts, tests/parity/memory.json); this one runs
// there too, and stays here for the host's refusal words, which no law pins
// yet. The plugin on its own is tested beside its code in mods/memory and
// cmd/memory.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { main } from "../cmd/memory/cli.ts"
import type { Result, Spec } from "./memory/run.ts"
import { DEPLOY, DEPLOY_FIXED, STRINGS_TASK } from "./memory/sim.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/memory.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = scratchDir("memory-e2e-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/memory/run.ts. */
const run = async (name = "run", tasks?: ReadonlyArray<string>): Promise<Result> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/memory"), ...(tasks === undefined ? {} : { tasks }) } satisfies Spec))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "memory/run.ts"), file], {
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
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the memory run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

interface ToolPart {
  readonly type: "tool"
  readonly name: string
  readonly state: { readonly status: string; readonly content?: ReadonlyArray<{ readonly text?: string }> }
}
const toolParts = (messages: unknown): ToolPart[] =>
  (messages as Array<{ type: string; content?: Array<{ type: string }> }>)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part): part is ToolPart => part.type === "tool")
const said = (part: ToolPart | undefined) => (part?.state.content ?? []).map((item) => item.text ?? "").join("\n")

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "an id, a limit and tags sent as strings are read as the number and the list; a word for an id is refused",
    async () => {
      const result = await run("strings", [STRINGS_TASK])
      const [saved, corrected, searched, forgot, refused, ...rest] = toolParts(result.messages[STRINGS_TASK])
      expect(rest).toEqual([])
      expect(said(saved)).toBe("Saved #1 (project).")
      expect(said(corrected)).toBe(`Corrected #1 (project); it said: "${DEPLOY}".`)
      expect(said(searched)).toContain(`#1 [project] ${DEPLOY_FIXED} [deploy, release]`)
      expect(forgot?.state.status).toBe("completed")
      expect(said(forgot)).toBe(`Forgot #1: "${DEPLOY_FIXED}".`)
      expect(refused?.state.status).toBe("error")
      expect(JSON.stringify(refused?.state)).toContain('Invalid arguments for tool \\"memory_forget\\":\\n- id: Expected number')

      const stats = await main(["stats", "--json"], { db: result.db, now: Date.now() })
      expect(JSON.parse(stats.out).total).toBe(0)
    },
    150_000,
  )
})

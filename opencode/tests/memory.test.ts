// The memory plugin in real OpenCode (the fork, through its SDK) on the
// scripted model, on a scratch memory file. A save, then a near repeat of it,
// keep one note, which a search finds; the next session starts with that note
// in its system prompt, and a note it saves mid-session leaves every one of
// its requests' system prompts as they were (the cached prefix holds) and
// shows in the session after. The CLI then reads the same file. The plugin on
// its own is tested beside its code in mods/memory and cmd/memory.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { main } from "../cmd/memory/cli.ts"
import type { Result, Spec } from "./memory/run.ts"
import { AGAIN_TASK, LATE, RECALL_TASK, REPEAT, SAVE_TASK } from "./memory/sim.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/memory.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "memory-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/memory/run.ts. */
const run = async (): Promise<Result> => {
  const base = join(scratch, "run")
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/memory") } satisfies Spec))
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
    "a note saved and repeated is one note; the next session starts with it, the same on every request; the CLI reads it",
    async () => {
      const result = await run()

      const [saved, repeated, searched, ...rest] = toolParts(result.messages[SAVE_TASK])
      expect(rest).toEqual([])
      expect(said(saved)).toBe("Saved #1 (global).")
      expect(said(repeated)).toStartWith("Updated #1 (global), which said nearly the same")
      expect(said(searched)).toContain(`#1 [global] ${REPEAT} [bun]`)

      // The first session had no notes when it started: no memory block, on any of its requests.
      expect(result.systems[SAVE_TASK]?.length).toBe(4)
      for (const system of result.systems[SAVE_TASK] ?? []) expect(system).not.toContain("# Memory")

      // The second starts with the note, and its own save mid-session leaves its system prompt unchanged.
      const recall = result.systems[RECALL_TASK] ?? []
      expect(recall).toHaveLength(2)
      expect(recall[0]).toContain(`# Memory`)
      expect(recall[0]).toContain(`- #1 ${REPEAT} [bun]`)
      expect(recall[1]).toBe(recall[0]!)
      expect(recall[0]).not.toContain(LATE)
      expect(said(toolParts(result.messages[RECALL_TASK])[0])).toBe("Saved #2 (project).")

      // The third sees both.
      const again = result.systems[AGAIN_TASK]?.[0] ?? ""
      expect(again).toContain(`- #1 ${REPEAT}`)
      expect(again).toContain(`- #2 ${LATE}`)

      // The CLI reads the plugin's file: two notes, the global one found by the search, the first shown in two digests.
      const stats = await main(["stats", "--json"], { db: result.db, now: Date.now() })
      expect(stats.code).toBe(0)
      const audit = JSON.parse(stats.out)
      expect(audit.total).toBe(2)
      expect(audit.notes[0]).toMatchObject({ id: 1, scope: "global", uses: 2, shown: 2 })
      expect(audit.notes[1]).toMatchObject({ id: 2, scope: "project", shown: 1 })
    },
    150_000,
  )
})

// Idle compaction in real OpenCode (the fork, through its SDK) on the scripted
// model, on a 20 s cache and a 5 s margin: a large session that goes idle is
// not compacted while its cache has time left, and is compacted through
// OpenCode's own compaction once the cache is 5 s from expiring. The rule and
// its timer are tested beside their code in mods/idle-compact and
// cmd/idle-compact.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./idle-compact/run.ts"
import { ANSWER, EARLY_MS, MARGIN_SECONDS, SUMMARY, TTL_SECONDS } from "./idle-compact/sim.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/idle-compact.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "idle-compact-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/idle-compact/run.ts. */
const run = async (name: string): Promise<Result> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/idle-compact") } satisfies Spec))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "idle-compact/run.ts"), file], {
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
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

/** The idle run, shared by the tests that read it. */
let idleRun: Promise<Result> | undefined
const idle = () => (idleRun ??= run("idle"))

// Whether the checkout's compaction request takes a `reason` the compaction message records.
const recordsReason = (dir: string) =>
  readFileSync(join(dir, "packages/schema/src/session-inbox.ts"), "utf8").includes("reason: SessionMessage.CompactionReason")

interface Message {
  readonly type: string
  readonly status?: string
  readonly summary?: string
  readonly reason?: string
}
const messagesOf = (context: unknown): ReadonlyArray<Message> => (Array.isArray(context) ? (context as Message[]) : [])
const compactions = (context: unknown) => messagesOf(context).filter((message) => message.type === "compaction")

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "an idle session is not compacted while its cache has time left, and is compacted once it is a margin from expiring",
    async () => {
      const result = await idle()
      const turn = result.seen.find((item) => item.kind === "turn")
      expect(turn).toBeDefined()
      // Ten seconds in, with five left before the margin: the session sat idle and nothing compacted it.
      expect(compactions(result.early)).toEqual([])
      expect(JSON.stringify(result.early)).toContain(ANSWER)
      expect(result.seen.filter((item) => item.at <= (turn?.at ?? 0) + EARLY_MS).map((item) => item.kind)).not.toContain("compaction")
      // Then, once: OpenCode's compaction ran on the sim, no sooner than the cache's lifetime less the margin.
      const summaries = result.seen.filter((item) => item.kind === "compaction")
      expect(summaries).toHaveLength(1)
      const due = (turn?.at ?? 0) + (TTL_SECONDS - MARGIN_SECONDS) * 1_000
      expect(summaries[0]?.at).toBeGreaterThanOrEqual(due)
      expect(summaries[0]?.at).toBeLessThan(due + 5_000)
      const [compaction] = compactions(result.late)
      expect(compaction?.status).toBe("completed")
      expect(compaction?.summary).toContain(SUMMARY)
      // No turn came after the prompt's: the compaction ran on its own.
      expect(result.seen.filter((item) => item.kind === "turn")).toHaveLength(1)
    },
    120_000,
  )

  test.skipIf(!fork || !recordsReason(fork))(
    "the idle compaction is recorded as automatic",
    async () => {
      const [compaction] = compactions((await idle()).late)
      expect(compaction?.reason).toBe("auto")
    },
    120_000,
  )

  test.skipIf(!fork || recordsReason(fork))(
    "a host without a compaction reason records the idle compaction as manual",
    async () => {
      const [compaction] = compactions((await idle()).late)
      expect(compaction?.reason).toBe("manual")
    },
    120_000,
  )
})

// Idle compaction in real OpenCode (the fork, through its SDK) on the scripted
// model, on a 20 s cache and a 5 s margin: a large session that goes idle is
// not compacted while its cache has time left, and is compacted through
// OpenCode's own compaction once the cache is 5 s from expiring, and so is one
// whose background shell outlives the cache, before the shell's notice wakes
// it. Its due time counts from the request's start as the host saw it, the
// plugin's clock, not from when the sim got it. With other directories open, so the host runs a copy of the plugin for
// each, the session is still compacted once. The rule and its timer are tested
// beside their code in mods/idle-compact and cmd/idle-compact.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec, Started } from "./idle-compact/run.ts"
import { ANSWER, BACKGROUND_SECONDS, EARLY_MS, MARGIN_SECONDS, SUMMARY, TTL_SECONDS } from "./idle-compact/sim.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/idle-compact.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "idle-compact-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/idle-compact/run.ts. */
const run = async (name: string, options: { readonly background?: boolean; readonly others?: number; readonly precompute?: boolean } = {}): Promise<Result> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/idle-compact"), ...options } satisfies Spec))
  const child = owned([process.execPath, join(import.meta.dir, "idle-compact/run.ts"), file], {
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
/**
 * When the compaction is due: the cache's lifetime less the margin, from the request's start as the host saw it,
 * the clock the plugin runs on. Not from when the sim got it: that request's trip from the host (tens of ms under
 * load, once 128) would read the plugin's on-time compaction as early.
 */
const dueAfter = (start: Started | undefined) => (start?.at ?? Number.NaN) + (TTL_SECONDS - MARGIN_SECONDS) * 1_000

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
      const due = dueAfter(result.started.find((item) => item.kind === "primary"))
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

  test(
    "with copies of the plugin for other directories on the host, the idle session is compacted once, by its own directory's",
    async () => {
      const result = await run("copies", { others: 2 })
      const summaries = result.seen.filter((item) => item.kind === "compaction")
      expect(summaries).toHaveLength(1)
      const due = dueAfter(result.started.find((item) => item.kind === "primary"))
      expect(summaries[0]?.at).toBeGreaterThanOrEqual(due)
      expect(summaries[0]?.at).toBeLessThan(due + 5_000)
      expect(compactions(result.late)).toHaveLength(1)
      // Three copies ran, and the idle window got one decision: one line scheduling it, one compacting it (the
      // compaction's own end is decided after, as not compacting).
      expect(result.log.filter((line) => line.message === "loading plugin")).toHaveLength(3)
      const session = result.log.find((line) => line.message === "idle-compact: compaction scheduled")?.sessionID
      expect(result.log.filter((line) => line.sessionID === session && line.message !== "idle-compact: not compacting").map((line) => [line.message, line.trigger])).toEqual([
        ["idle-compact: compaction scheduled", "settled"],
        ["idle-compact: compacting the idle session before its cache expires", "timer"],
      ])
    },
    120_000,
  )

  test(
    "with background compaction on, the idle compaction swaps in the summary the host held, and asks the model for none",
    async () => {
      const result = await run("precompute", { precompute: true })
      // The one summary request came as the turn ended (the host's background summary), long before the idle one was due.
      const summaries = result.seen.filter((item) => item.kind === "compaction")
      expect(summaries).toHaveLength(1)
      const due = dueAfter(result.started.filter((item) => item.kind === "primary").at(-1))
      expect(summaries[0]?.at).toBeLessThan(due - 5_000)
      expect(compactions(result.early)).toEqual([])
      // Then the plugin compacted on time, and the compaction took the held summary: no second request.
      const session = result.log.find((line) => line.message === "idle-compact: compaction scheduled")?.sessionID
      expect(result.log.some((line) => line.sessionID === session && line.message.startsWith("idle-compact: compacting"))).toBe(true)
      const [compaction] = compactions(result.late)
      expect(compaction?.status).toBe("completed")
      expect(compaction?.summary).toContain(SUMMARY)
      expect(result.started.filter((item) => item.kind === "compaction")).toHaveLength(1)
      expect(result.seen.filter((item) => item.kind === "turn")).toHaveLength(2)
    },
    120_000,
  )

  test(
    "a session idle behind a background shell that outlives its cache is compacted a margin from expiry, before the shell's notice wakes it",
    async () => {
      const result = await run("background", { background: true })
      const compaction = result.seen.find((item) => item.kind === "compaction")
      expect(compaction).toBeDefined()
      // The cache's last refresh: the turn's last request before the compaction, the one after the shell started.
      const turns = result.seen.filter((item) => item.kind === "turn")
      expect(turns.filter((item) => item.at < (compaction?.at ?? 0))).toHaveLength(2)
      const compacting = result.started.find((item) => item.kind === "compaction")
      const due = dueAfter(result.started.filter((item) => item.kind === "primary" && item.at < (compacting?.at ?? 0)).at(-1))
      expect(compaction?.at).toBeGreaterThanOrEqual(due)
      expect(compaction?.at).toBeLessThan(due + 5_000)
      // The shell was still running then: its notice woke the session afterwards, onto the summary.
      const wake = turns.find((item) => item.at > (compaction?.at ?? 0))
      expect(wake).toBeDefined()
      expect(wake?.at).toBeGreaterThanOrEqual((turns[0]?.at ?? 0) + BACKGROUND_SECONDS * 1_000)
      expect(result.seen.filter((item) => item.kind === "compaction")).toHaveLength(1)
      const [summary] = compactions(result.late)
      expect(summary?.status).toBe("completed")
      expect(JSON.stringify(result.late)).toContain(`sleep ${BACKGROUND_SECONDS}`)
    },
    120_000,
  )
})

// A compaction's summary request keeps the cached prefix, in real OpenCode (the
// fork, through its SDK) on the scripted model, with the plugins that write the
// system prompt loaded as the owner loads them. For each way a session
// compacts (automatic, past the window's ceiling; idle, through cmd/idle-compact;
// background, the host's summary written as a turn ends), the summary request
// sends the tools and every message of the request before it byte for byte,
// the memory digest in the system prompt included, and only adds after them:
// a prompt cache then reads the whole conversation instead of the tools and
// the first system blocks. The plugins' own hooks are tested beside their code.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Mode, Result, Spec } from "./compaction-prefix/run.ts"
import { NOTE, type Seen } from "./compaction-prefix/sim.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/compaction-prefix.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "compaction-prefix-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/compaction-prefix/run.ts. */
const run = async (mode: Mode): Promise<Result> => {
  const base = join(scratch, mode)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  const spec: Spec = { base, fork: resolve(fork ?? ""), mode, memory: join(ROOT, "cmd/memory"), idleCompact: join(ROOT, "cmd/idle-compact") }
  writeFileSync(file, JSON.stringify(spec))
  const child = owned([process.execPath, join(import.meta.dir, "compaction-prefix/run.ts"), file], {
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
  const timer = setTimeout(() => child.kill(), 90_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the ${mode} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

/** The first summary request and the conversation request sent right before it. */
const pair = (seen: ReadonlyArray<Seen>) => {
  const index = seen.findIndex((item) => item.kind === "compaction")
  const summary = seen[index]
  const before = seen.slice(0, Math.max(0, index)).findLast((item) => item.kind === "turn")
  return { summary, before }
}

/** Where the summary request first leaves the request before it, as the cache reads it: tools, then messages in order. */
const firstDifference = (before: Seen, summary: Seen): string | undefined => {
  if (JSON.stringify(summary.body.tools ?? null) !== JSON.stringify(before.body.tools ?? null)) return "tools"
  const previous = before.body.messages ?? []
  const next = summary.body.messages ?? []
  for (let index = 0; index < previous.length; index += 1) {
    const was = JSON.stringify(previous[index])
    const is = JSON.stringify(next[index])
    if (was === is) continue
    if (was === undefined || is === undefined) return `messages[${index}] (${previous[index]?.role}): ${is === undefined ? "missing" : "added"}`
    let at = 0
    while (at < was.length && was[at] === is[at]) at += 1
    return `messages[${index}] (${previous[index]?.role}) at char ${at}: was …${was.slice(at, at + 120)}… is …${is.slice(at, at + 120)}…`
  }
  return next.length > previous.length ? undefined : "nothing appended"
}

const systemOf = (item: Seen | undefined) =>
  JSON.stringify((item?.body.messages ?? []).filter((message) => message.role === "system"))

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test.each<[Mode, string]>([
    ["auto", "an automatic compaction"],
    ["idle", "an idle compaction (cmd/idle-compact)"],
    ["background", "a background summary"],
  ])(
    "%s: %s sends the request before it byte for byte, the memory digest included, and adds the summary prompt after",
    async (mode) => {
      const result = await run(mode)
      const { summary, before } = pair(result.seen)
      expect(summary).toBeDefined()
      expect(before).toBeDefined()
      if (mode !== "background") expect(result.compacted).toBe(true)
      // The request before carries the digest, so the summary request is held to it.
      expect(systemOf(before)).toContain(NOTE)
      expect(firstDifference(before!, summary!)).toBeUndefined()
    },
    120_000,
  )
})

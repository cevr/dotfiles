// Runs scenarios/prime-wake.ts with the Prime look and the orchestrate plugin
// against an OpenCode checkout: a worker moves a shell command (one that runs
// until the scenario releases it) to the background and ends its turn. While it waits its live row reads
// waiting (its still symbol) with what it said last, and OpenCode reports that
// line to the parent with the shell still running; once the shell's notice
// wakes it, the answer it writes then reaches the parent as a second report
// (OpenCode reports a subagent each time it goes idle). It needs OPENCODE_DEV.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-wake.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["bg-waiting", "bg-done"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { "bg-waiting": [], "bg-done": [] }

/** The row lines beneath the dock's count line, up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  if (dock < 0) return []
  const after = frame.slice(dock + 1)
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

describe.skipIf(!fork)("a worker waiting on its own background shell (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-wake-")
  beforeAll(kept.setup(async () => {
    const out = kept.dir("prime-wake-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-wake.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code} (its frames and logs: ${out}):\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `wake-${name}.txt`), "utf8").split("\n")
  }), 300_000)

  test("a worker that ended its turn to wait on its shell reads waiting, by its still symbol and what it said after starting the shell, and counts", kept.test(() => {
    expect(frames["bg-waiting"].join("\n")).toContain("Worker started.")
    // The dock counts it among the working subagents, though the host has it idle.
    expect(frames["bg-waiting"].some((line) => line.includes("◆ 1 subagent  ·"))).toBe(true)
    expect(rows(frames["bg-waiting"])).toEqual([expect.stringMatching(/^◈ worker gpt  Run the slow check  Waiting for the check\. · \d+s$/)])
  }))

  test("the parent hears the waiting line with the shell still running, then the answer the worker wrote after its shell finished", kept.test(() => {
    const waiting = frames["bg-waiting"].join("\n")
    expect(waiting).toContain("Background work still running:")
    expect(waiting).toContain("Root heard it waits.")
    expect(waiting).not.toContain("Root heard: the background check passed.")
    const done = frames["bg-done"].join("\n")
    expect(done).toContain("Background check passed after its shell.")
    expect(done).toContain("Root heard: the background check passed.")
  }))
})

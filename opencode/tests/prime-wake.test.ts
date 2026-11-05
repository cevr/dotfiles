// Runs scenarios/prime-wake.ts with the Prime look and the orchestrate plugin
// against an OpenCode checkout: a worker moves a three-second shell command
// to the background and ends its turn. While it waits its live row reads
// waiting (its still symbol) with what it said last; once the shell's notice wakes it, the answer it
// writes then is the one its parent gets, as a background worker's stop
// notice and as a foreground call's result. It needs OPENCODE_DEV, the fork
// whose subagent jobs wait for their child's own background work.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-wake.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["bg-waiting", "bg-done", "fg-waiting", "fg-done"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { "bg-waiting": [], "bg-done": [], "fg-waiting": [], "fg-done": [] }

/** The row lines beneath the dock's count line, up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  if (dock < 0) return []
  const after = frame.slice(dock + 1)
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

describe.skipIf(!fork)("a worker waiting on its own background shell (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-wake-"))
    const run = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-wake.ts"], {
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
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `wake-${name}.txt`), "utf8").split("\n")
  }, 300_000)

  test("a background worker that ended its turn to wait on its shell reads waiting, by its still symbol and what it said after starting the shell, and counts", () => {
    expect(frames["bg-waiting"].join("\n")).toContain("Worker started.")
    // The dock counts it among the working subagents, though the host has it idle.
    expect(frames["bg-waiting"].some((line) => line.includes("◆ 1 subagent  ·"))).toBe(true)
    expect(rows(frames["bg-waiting"])).toEqual([expect.stringMatching(/^◈ worker gpt  Run the slow check  Waiting for the check\. · \d+s$/)])
  })

  test("the parent's stop notice carries the answer the worker wrote after its shell finished, not its waiting line", () => {
    const frame = frames["bg-done"].join("\n")
    expect(frame).toContain("Root heard: the background check passed.")
    expect(frame).not.toContain("Root heard too early.")
  })

  test("in the foreground the same: the row waits while the call runs, and the call's result is the later answer", () => {
    expect(rows(frames["fg-waiting"])).toContainEqual(
      expect.stringMatching(/^◈ worker gpt  Check it in the foreground  Waiting for the check\. · \d+s$/),
    )
    const frame = frames["fg-done"].join("\n")
    expect(frame).toContain("Root heard: the foreground check passed.")
    expect(frame).not.toContain("Root heard too early.")
  })
})

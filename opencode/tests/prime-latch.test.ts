// accept: deep (39.5 s alone on a quiet host: 1-minute load 6.3–7.2 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Runs scenarios/prime-latch.ts with the Prime look, the orchestrate and
// wakes plugins and a stand-in pool against an OpenCode checkout: a worker
// started in the foreground while the pace holds latches instead of being
// refused. The call answers at once and the parent goes on; the worker's row
// beneath the composer reads latched, with the hold and when it opens;
// once the pace admits, the worker runs and its answer wakes the parent. The
// listing and the latch's decisions run on the simulated host:
// cmd/orchestrate/orchestrate-latch.sim.test.ts (tests/parity/orchestrate.json).
// It needs OPENCODE_DEV, the fork with the plugin hook points the Prime rows use.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-latch.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["latch-latched", "latch-done"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { "latch-latched": [], "latch-done": [] }

/** The row lines beneath the dock's rule and its count line (gone while nothing is active), up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const rule = frame.findLastIndex((line) => /^ ─{20,}$/.test(line))
  if (rule < 0) return []
  const counted = / ◆ \d+ subagents?  ·/.test(frame[rule + 1] ?? "")
  const after = frame.slice(rule + (counted ? 2 : 1))
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

describe.skipIf(!fork)("a subagent latched on the pace (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-latch-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-latch-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-latch.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
  }, 300_000))

  test("the held foreground call answers latched at once, and the parent goes on", kept.test(() => {
    expect(frames["latch-latched"].join("\n")).toContain("Latched; I will hear back.")
  }))

  test("its row reads latched, with the hold and when it opens, and the dock counts it", kept.test(() => {
    expect(rows(frames["latch-latched"])).toEqual([expect.stringMatching(/^◇ worker gpt  Check the export  pace · opens \d\d:\d\d · \d+s$/)])
    expect(frames["latch-latched"].some((line) => line.includes("◆ 1 subagent  ·"))).toBe(true)
  }))

  test("its answer wakes the parent, and its row reads done", kept.test(() => {
    const frame = frames["latch-done"]
    expect(frame.join("\n")).toContain("Root heard: the export check passed.")
    expect(rows(frame)).toContainEqual(expect.stringMatching(/^◆ worker gpt  Check the export  /))
  }))
})

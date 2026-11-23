// accept: deep (25.4 s alone on a quiet host: 1-minute load 6.7–7.4 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Runs scenarios/prime-fallback.ts with the Prime look, the orchestrate and
// wakes plugins, a stand-in pool and a stand-in Codex provider against an
// OpenCode checkout: a planner (Codex plans and verifies, never implements) the pool holds on its first model starts at
// once on the newest Codex sol, which the admission script admits, instead
// of latching, and the parent hears its answer; its row shows sol. The pace,
// the admission, the call log, the worker's model and what the parent reads
// run on the simulated host: cmd/orchestrate/orchestrate-fallback.sim.test.ts
// (tests/parity/orchestrate.json). It needs OPENCODE_DEV, the fork with the
// plugin hook points the Prime rows use.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-fallback.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
let frame: ReadonlyArray<string> = []

describe.skipIf(!fork)("a held subagent falls back to Codex (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-fallback-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-fallback-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-fallback.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    frame = readFileSync(join(out, "fallback-done.txt"), "utf8").split("\n")
  }, 300_000))

  test("the parent reads where it ran and why, first in the call's result, then the answer, and its row shows sol", kept.test(() => {
    expect(frame.join("\n")).toContain("Root heard: the export check passed.")
    expect(frame.map((line) => line.trim())).toContainEqual(expect.stringMatching(/^◆ planner sol 6\.1  Check the export  /))
  }))
})

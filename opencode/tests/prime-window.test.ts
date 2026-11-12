// The tray's context share reads against the window compaction plans for.
//
// The owner (2026-11-11): Opus 5.5 takes 1M tokens, but every primary agent
// and role compacts at 400k (cmd/orchestrate's `compactionWindow`), so its
// 207k read "21%" where "52%" was meant. The share now counts against the
// model's window capped by the step's agent's compaction window
// (mods/prime/usage.ts `effectiveWindow`), as the fork's compaction does.
//
// scenarios/prime-demo.ts runs with the Prime look on a 262k model, its
// build agent given a 128k compaction window by a fixture plugin; the last
// turn's 64k then reads 50%, where the model's window alone reads 24%
// (tests/prime.test.ts, no window).
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-window.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const root = join(import.meta.dir, "..")

describe.skipIf(!fork)("the tray's context share under an agent's compaction window (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-window-")
  let frame = ""

  beforeAll(kept.setup(async () => {
    const out = kept.dir("prime-window-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-demo.ts"], {
      cwd: root,
      env: {
        ...process.env,
        SCENARIO_PRIME: "1",
        SCENARIO_THEME: "prime",
        SCENARIO_WINDOW: "128000",
        SCENARIO_CACHED: "60000",
        SCENARIO_OUT: out,
        SCENARIO_LABEL: "window",
        OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    frame = readFileSync(join(out, "window.txt"), "utf8")
  }), 300_000)

  test("64k on a 262k model whose agent compacts at 128k reads 50%, then the turn's cache share", kept.test(() => {
    // The turn's one metered step read 60k of its 63k prompt tokens from the cache: 95%, after the context share, right-aligned.
    expect(frame).toMatch(/^ {20,}gpt-sim-model · 64k \(50%\) · cache 95%$/m)
    expect(frame).not.toContain("(24%)")
  }))
})

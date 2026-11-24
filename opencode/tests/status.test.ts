// @reads ../skills/orchestrate/scripts/{status,request,transition}.ts
// accept: deep (21.0 s alone on a quiet host: 1-minute load 72.7–74.0 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Public UI seam: real OpenCode, real status plugin, fake pool/bridge RPC,
// real logged and running subagent; shared status.ts reads real unit logs.
import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { matchingInput, readScratchFileSync as readFileSync, scratchExistsSync as existsSync } from "./read-path.ts"
import { keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/status.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("/pool in the Prime look", () => {
  const kept = keptScratch(Boolean(fork), "status-")
  test("shows held accounts and both quota windows, a live agent and derived run states", kept.test(async () => {
    const out = kept.dir("pool-pane-")
    const scripts = join(out, "status")
    mkdirSync(scripts)
    for (const name of ["status.ts", "request.ts", "transition.ts"]) {
      copyFileSync(matchingInput("../skills/orchestrate/scripts/{status,request,transition}.ts", `../skills/orchestrate/scripts/${name}`), join(scripts, name))
    }
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/pool.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"),
        SCENARIO_STATUS_SCRIPT: join(scripts, "status.ts"),
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`pool scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(join(out, "pool-timeout.txt")) ? readFileSync(join(out, "pool-timeout.txt"), "utf8") : ""}`)
    const frame = readFileSync(join(out, "pool.txt"), "utf8")
    for (const text of ["Account pool", "store:alpha", "store:beta", "held (usage-limit)", "5h 23%/100% used", "7d 44%/100% used", "5h 100%/100% used", "7d 72%/100% used", "reset 2026-11-04 16:00Z", "Running agents (1)", "verifier pane r1", "wake · implement · r1", "◆ 1 subagent", "0 shells"]) expect(frame).toContain(text)
    // The status script lists open units only: the merged one is left out.
    expect(frame).not.toContain("merged abcdef1")
    expect(readFileSync(join(out, "pool-loading.txt"), "utf8")).toContain("Loading accounts…")
    const failed = readFileSync(join(out, "pool-error.txt"), "utf8")
    expect(failed).toContain("Pool unavailable; keeping last reading")
    expect(failed).toContain("store:alpha")
    const empty = readFileSync(join(out, "pool-empty.txt"), "utf8")
    expect(empty).toContain("No pool accounts.")
    const closed = readFileSync(join(out, "pool-closed.txt"), "utf8")
    expect(closed).not.toContain("Account pool")
    expect(closed).toContain("typed-after-pool")
    expect(empty).not.toContain("store:alpha")
    const sidebar = readFileSync(join(out, "pool-sidebar.txt"), "utf8")
    // The sidebar shares its rows with the transcript, so match its lines in order.
    const rows = sidebar.split("\n")
    const at = (line: RegExp) => rows.findIndex((row) => line.test(row))
    const section = [/\sPool$/, /\salpha$/, /\sweek 44%\/100% used · in 1d 0h$/, /\s5h 23%\/100% used · in 1h 2\dm · \d\d:\d\dZ$/].map(at)
    const [first = -1] = section
    expect(first).toBeGreaterThan(-1)
    // Each row fits the sidebar, so the four are adjacent: none wraps.
    expect(section).toEqual([first, first + 1, first + 2, first + 3])
    expect(JSON.parse(readFileSync(join(out, "pool-session-query.json"), "utf8"))).toMatchObject({ sessionID: expect.stringMatching(/^ses_/), providerID: "simulation" })
  }), hangGuard("fork-turn"))
})

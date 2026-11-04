// Public UI seam: real OpenCode, real status plugin, fake pool/bridge RPC,
// real logged and running subagent; shared status.ts reads real unit logs.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/status.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("/pool in the Prime look", () => {
  test("shows held accounts and both quota windows, a live agent, a Codex thread and derived run states", async () => {
    const out = mkdtempSync(join(tmpdir(), "pool-pane-"))
    const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/pool.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`pool scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(join(out, "pool-timeout.txt")) ? readFileSync(join(out, "pool-timeout.txt"), "utf8") : ""}`)
    const frame = readFileSync(join(out, "pool.txt"), "utf8")
    for (const text of ["Account pool", "gent:alpha", "gent:beta", "held (usage-limit)", "5h 23%", "7d 44%", "5h 100%", "7d 72%", "reset 2026-11-04 16:00Z", "Running agents (1)", "implementor pane r1", "Codex threads (1)", "implementor bridge r1", "luna max", "wake · implement · r1", "closed · merged abcdef1 · r2", "◆ 1 subagent", "▸ 0 shells"]) expect(frame).toContain(text)
    expect(readFileSync(join(out, "pool-loading.txt"), "utf8")).toContain("Loading accounts…")
    const failed = readFileSync(join(out, "pool-error.txt"), "utf8")
    expect(failed).toContain("Pool unavailable; keeping last reading")
    expect(failed).toContain("gent:alpha")
    const empty = readFileSync(join(out, "pool-empty.txt"), "utf8")
    expect(empty).toContain("No pool accounts.")
    const closed = readFileSync(join(out, "pool-closed.txt"), "utf8")
    expect(closed).not.toContain("Account pool")
    expect(closed).toContain("typed-after-pool")
    expect(empty).not.toContain("gent:alpha")
    console.log(`Status pane artifacts: ${out}`)
  }, 150_000)
})

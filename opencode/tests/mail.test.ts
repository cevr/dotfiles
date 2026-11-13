// Public seam: real OpenCode, the real mail plugin, three sessions on scripted
// models (scenarios/mail.ts): A pings an idle B, which answers A; A steers C.
// What only the real host shows stays here: the TUI's frame of A. The
// sessions, letters, receipts and model requests are cmd/mail/mail.sim.test.ts's
// (tests/parity/mail.json).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/mail.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("session mail", () => {
  const kept = keptScratch(Boolean(fork), "mail-")
  // Real only: the world draws no TUI (sim-tui), so the notice row is read off the real frame.
  test("the TUI draws a letter in the sender's transcript as one ✉ notice row, between its turns", kept.test(async () => {
    const out = kept.dir("mail-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/mail.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "mail-timeout.txt")
    if (code !== 0) throw new Error(`mail scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

    const exchange = readFileSync(join(out, "mail-exchange.txt"), "utf8")
    const row = exchange.indexOf("✉ from Mail B · mail-pong")
    expect(row).toBeGreaterThan(exchange.indexOf("A sent the ping"))
    expect(row).toBeLessThan(exchange.indexOf("A got the pong"))
    expect(exchange.indexOf("A sent the ping")).toBeGreaterThanOrEqual(0)
    expect(exchange).not.toContain("It is not the user speaking")
  }), 150_000)
})

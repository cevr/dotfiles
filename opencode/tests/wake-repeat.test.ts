// accept: deep (18.7 s alone on a quiet host before the monitor moved to the simulated host: 1-minute load 45.1–62.5 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Public seam: real OpenCode with `experimental.schedules` on, the real wake
// server plugin, the built-in schedule plugin off as daily writes it, and a
// scripted model. scenarios/wake-repeat.ts asks the model once, keeping the
// tools it was offered. The schedule tools must be gone from the request
// while the flag is on, and the `/schedule` command from the server's
// commands: what the real host's config (the built-in plugin off) shows. The
// repeating monitor (each change one short synthetic notice, never a user
// prompt; a cancel stops it) runs on the simulated host under the same name:
// cmd/wake/wake-repeat.sim.test.ts, by tests/parity/wake.json.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

interface Request {
  readonly session?: "root" | "title"
  readonly request: string
}

const label = "wake-repeat"
const run = async (out: string) => {
  const child = owned(["bunx", "opencode-drive", "run", "scenarios/wake-repeat.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = join(out, `${label}-timeout.txt`)
  if (code !== 0) throw new Error(`${label} scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
  return { read: (name: string) => readFileSync(join(out, `${label}-${name}`), "utf8") }
}

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/wake-repeat.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("with OpenCode's schedules on", () => {
  const kept = keptScratch(Boolean(fork), "wake-repeat-")
  test("the schedule tools are gone, and a repeating monitor wakes the session once per change with a short notice", kept.test(async () => {
    const out = kept.dir(`${label}-`)
    const { read } = await run(out)
    const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
    const root = requests.filter((request) => request.session === "root")

    // The flag is on, yet with the built-in schedule plugin off neither its /schedule command nor a schedule tool is offered; ours are.
    const commands: ReadonlyArray<string> = JSON.parse(read("commands.json"))
    expect(commands).toContain("review")
    expect(commands).not.toContain("schedule")
    expect(root.length).toBeGreaterThan(0)
    for (const request of root) {
      expect(request.request).not.toMatch(/schedule_(create|list|pause|resume|delete)/)
      expect(request.request).toContain("wake_cancel")
    }
  }), 180_000)
})

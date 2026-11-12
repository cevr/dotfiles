// Real OpenCode with the recover TUI plugin (cmd/recover): scenarios/recover.ts
// strands a session in a removed folder and opens it, and the plugin moves it
// back to the project, toasting where it went.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/recover.test.ts: skipped. Set OPENCODE_DEV to the fork.")

describe.skipIf(!fork)("session recover", () => {
  test("a session whose folder is gone goes back to where it was, with a toast", async () => {
    using held = scratch("recover-")
    const out = held.path
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/recover.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "recover-timeout.txt")
    if (code !== 0) throw new Error(`recover scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

    const locations = JSON.parse(readFileSync(join(out, "recover-locations.json"), "utf8"))
    expect(locations.movedIn).toBe(locations.rift)
    expect(locations.recovered).toBe(locations.born)

    // The toast says where the session went and which folder is gone, home as ~ (the scenario's home is its run folder).
    expect(readFileSync(join(out, "recover-moved.txt"), "utf8")).toContain("Moved to ~: ~/files/rift no longer exists")
    // The session moved back once, and the host's "Choose directory" prompt is not left up.
    const settled = readFileSync(join(out, "recover-settled.txt"), "utf8")
    expect(settled.split("↳ Moved to").length - 1).toBe(2)
    expect(settled).not.toContain("Session location unavailable")
  }, 150_000)
})

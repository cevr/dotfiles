// Public tool seam: real OpenCode with the real git server plugin and a
// stand-in `gh` (scenarios/pr.ts). The model's `pr` watch answers with the
// request and its pending checks; when the checks pass, the per-machine
// watcher's notice comes into the session as a `◈` row and wakes it, and the
// watch ends.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/pr.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("the pr tool and its watcher", () => {
  test("a watch set in a turn sends its notice into the idle session when the checks pass", async () => {
    using held = scratch("pr-tool-")
    const out = held.path
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/pr.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0)
      throw new Error(`pr scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(join(out, "pr-timeout.txt")) ? readFileSync(join(out, "pr-timeout.txt"), "utf8") : ""}`)

    expect(readFileSync(join(out, "pr-watch.txt"), "utf8")).toContain("● pr action=watch, note=merge it when green")
    // What the model read back from the tool.
    expect(readFileSync(join(out, "pr-tool-result.json"), "utf8")).toContain(
      "Watching biteinc/maitred#412 Pay with points until green: checks pending.\\nA notice comes into this session when it fires; end your turn or do other work, and do not poll.",
    )

    const notice = readFileSync(join(out, "pr-notice.txt"), "utf8")
    expect(notice).toContain("◈ PR biteinc/maitred#412: checks pending → pass")
    // The model answered the turn the notice woke, which it does only when it read the notice's text.
    expect(notice).toContain("pr-notice-read")

    // GitHub was read through one GraphQL call per pass, never a REST read of the request's body.
    const calls = JSON.parse(readFileSync(join(out, "gh-calls.json"), "utf8")) as ReadonlyArray<ReadonlyArray<string>>
    expect(calls.some((call) => call[0] === "api" && call[1] === "graphql")).toBe(true)
    expect(calls.filter((call) => call[0] === "api" && call[1] === "--include").every((call) => call.includes("--silent"))).toBe(true)
  }, 150_000)
})

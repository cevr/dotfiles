// accept: deep (28.7 s alone on a quiet host: 1-minute load 10.0–13.5 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Public seam: real OpenCode with the orchestrate (server and TUI), status
// and queue plugins, on a scripted model (scenarios/idle-root.ts). A root that
// owns an orchestrate run with units in plan and implement goes idle: it is
// not nudged while its planner runs, nor while the owner's draft sits in the
// composer; once the draft clears it is steered with exactly one line, names
// its wait as a queue item the sidebar shows, and is not nudged again.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const LINE = "idle with units in plan, implement or verify: alpha, beta; start them or name what you wait on."

const count = (text: string, part: string) => text.split(part).length - 1

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/idle-root.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("an idle root with units to move", () => {
  const kept = keptScratch(Boolean(fork), "idle-root-")
  test("is steered once, after its planner ends and the owner's draft clears, and names its wait", kept.test(async () => {
    const out = kept.dir("idle-root-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/idle-root.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "idle-root-timeout.txt")
    if (code !== 0) throw new Error(`idle-root scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
    const frame = (name: string) => readFileSync(join(out, `idle-root-${name}.txt`), "utf8")

    // Idle with its planner running: no nudge.
    const started = frame("started")
    expect(started).toContain("Started alpha's planner.")
    expect(started).not.toContain(LINE)

    // Idle again after the planner's notice, with a draft in the composer: no nudge.
    const drafted = frame("drafted")
    expect(drafted).toContain("Alpha's plan is in.")
    expect(drafted).toContain("half a thought")
    expect(drafted).not.toContain(LINE)

    // The draft cleared: one nudge, answered by a named wait the sidebar shows.
    const nudged = frame("nudged")
    expect(count(nudged, LINE)).toBe(1)
    expect(nudged).toContain("Named the wait.")
    expect(nudged).toMatch(/… Owner review of alpha/)

    // Idle after the nudge, and after the owner's next prompt, with the wait named: no second nudge.
    const final = frame("final")
    expect(final).toContain("Still waiting on the owner's review.")
    expect(count(final, LINE)).toBe(1)
    const requests: ReadonlyArray<string> = JSON.parse(readFileSync(join(out, "idle-root-requests.json"), "utf8"))
    expect(requests.filter((last) => last.includes(LINE))).toHaveLength(1)
  }), 200_000)
})

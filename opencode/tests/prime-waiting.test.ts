// Runs scenarios/prime-waiting.ts with the Prime look and the orchestrate
// plugin against an OpenCode checkout: a worker backgrounds a long shell and a
// short one and ends its turn, so its row waits and the host's Subagents
// panel lists it as active, waiting; woken by the short one's notice, it
// kills the long one with shell({ action: "kill", id }), which sends no notice, and stops. Its
// row then leaves the live rows, the dock's count drops to 0 and the panel
// lists no active subagent: whether it works is the host's live state, never
// a notice that did not come. It needs OPENCODE_DEV, the fork whose panel
// counts a subagent waiting on its own running work as active.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-waiting.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["waiting-rows", "waiting-panel", "ended-rows", "ended-panel"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>
let requests: ReadonlyArray<string> = []

/** The dock's count line and the row lines beneath it, up to the first line that is no row. */
function dock(frame: ReadonlyArray<string>) {
  const at = frame.findIndex((line) => /^ ◆ \d+ subagents?  ·/.test(line))
  if (at < 0) return { count: undefined, rows: [] }
  const after = frame.slice(at + 1)
  const end = after.findIndex((line) => !/^ [◆◇◈] /.test(line))
  return { count: frame[at]!.trim(), rows: (end < 0 ? after : after.slice(0, end)).map((line) => line.trim()) }
}
/** The Subagents panel's entries, between its tab line and its hint line. */
function panel(frame: ReadonlyArray<string>) {
  const at = frame.findIndex((line) => line.includes("Subagents  Shell"))
  const end = frame.findIndex((line, index) => index > at && line.includes("show inactive"))
  return frame
    .slice(at + 1, end)
    .map((line) => line.replace(/^ ┃/, "").trim())
    .filter(Boolean)
}

describe.skipIf(!fork)("a waiting subagent's wait ends with no notice (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-waiting-"))
    const run = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-waiting.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
    requests = JSON.parse(readFileSync(join(out, "prime-waiting-requests.json"), "utf8"))
  }, 300_000)

  test("while its shells run, its row waits and the dock counts it", () => {
    expect(dock(frames["waiting-rows"])).toEqual({
      count: "◆ 1 subagent  ·  0 shells",
      rows: [expect.stringMatching(/^◈ worker gpt  Run the proof  Waiting for the proof\. · \d+s$/)],
    })
  })

  test("the host's Subagents panel lists it as active, waiting, as the dock counts it", () => {
    expect(panel(frames["waiting-panel"])).toEqual([expect.stringMatching(/^Worker: Run the proof +Waiting$/)])
  })

  test("killed through its handle, the proof wait sends no notice: the worker only ever heard of the short shell", () => {
    const last = requests.findLast((request) => request.includes("Worker brief P.") && request.includes("call_kill")) ?? ""
    expect(last.match(/<shell id=/g)?.length).toBe(1)
  })

  test("once it stopped, its row is no longer live, the dock counts none and the panel lists none: both agree", () => {
    expect(dock(frames["ended-rows"])).toEqual({ count: "◆ 0 subagents  ·  0 shells", rows: ["◆ worker gpt  Run the proof  5 steps"] })
    expect(panel(frames["ended-panel"])).toEqual(["No active subagents"])
  })
})

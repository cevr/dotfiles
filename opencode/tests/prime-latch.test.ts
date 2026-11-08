// Runs scenarios/prime-latch.ts with the Prime look, the orchestrate and
// wakes plugins and a stand-in pool against an OpenCode checkout: a worker
// started in the foreground while the pace holds latches instead of being
// refused. The call answers at once and the parent goes on; the worker's row
// beneath the composer reads latched, with the hold and when it opens;
// wake_list shows the latch. Decided again while the pace still holds, it
// latches again; once the pace admits, the worker starts in the background
// on the child made when it latched, and its answer wakes the parent. It
// needs OPENCODE_DEV, the fork with the plugin hook points the Prime rows use.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-latch.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["latch-latched", "latch-done"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { "latch-latched": [], "latch-done": [] }
let listing = ""
let calls: ReadonlyArray<Record<string, unknown>> = []
let paces: ReadonlyArray<Record<string, unknown>> = []

const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/** The row lines beneath the dock's count line, up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  if (dock < 0) return []
  const after = frame.slice(dock + 1)
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

describe.skipIf(!fork)("a subagent latched on the pace (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-latch-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-latch.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
    listing = (JSON.parse(readFileSync(join(out, "latch-wakes.json"), "utf8")) as { request: string }).request
    calls = jsonl(join(out, "agents.jsonl"))
    paces = jsonl(join(out, "pace.jsonl"))
  }, 300_000)

  test("the held foreground call answers latched at once, and the parent goes on", () => {
    expect(frames["latch-latched"].join("\n")).toContain("Latched; I will hear back.")
  })

  test("its row reads latched, with the hold and when it opens, and the dock counts it", () => {
    expect(rows(frames["latch-latched"])).toEqual([expect.stringMatching(/^◇ worker gpt  Check the export  pace · opens \d\d:\d\d · \d+s$/)])
    expect(frames["latch-latched"].some((line) => line.includes("◆ 1 subagent  ·"))).toBe(true)
  })

  test("wake_list shows the latch: the subagent, its child, the hold and when it opens", () => {
    expect(listing).toContain("latch · the worker subagent \\\"Check the export\\\" (sessionID: ses_")
    expect(listing).toContain("held by the pace: scripted 5h window is full · opens ")
  })

  test("decided again while still held it latches again; once admitted it starts in the background on its child", () => {
    expect(calls.map((line) => line.kind)).toEqual(["latched", "done", "latched", "call", "done"])
    const child = calls[0]?.child
    expect(typeof child).toBe("string")
    expect(calls.every((line) => line.child === child)).toBe(true)
    expect(calls[1]).toMatchObject({ status: "latched" })
    expect(calls[3]).toMatchObject({ agent: "worker", description: "Check the export", background: true })
    expect(calls[4]).toMatchObject({ status: "running" })
    // The pace was asked three times, about six seconds apart (no busy loop), and told of the start once.
    expect(paces.map((line) => (line.started === true ? "started" : line.ok === true ? "ok" : "held"))).toEqual(["held", "held", "ok", "started"])
    const at = paces.map((line) => Number(line.at))
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(5_000)
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(5_000)
  })

  test("its answer wakes the parent, and its row reads done", () => {
    const frame = frames["latch-done"]
    expect(frame.join("\n")).toContain("Root heard: the export check passed.")
    expect(rows(frame)).toContainEqual(expect.stringMatching(/^◆ worker gpt  Check the export  /))
  })
})

// Runs scenarios/prime-sidebar.ts with the Prime look and the orchestrate
// plugin against an OpenCode checkout and asserts that the live subagent rows
// beneath the composer stay while the session's sidebar shows: wide, the
// sidebar holds the session and the worker's row is under the dock's count;
// narrow, with no sidebar, it is there too. It needs OPENCODE_DEV.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-sidebar.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["wide", "narrow", "wide-again"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { wide: [], narrow: [], "wide-again": [] }
// The scenario's widths are 160 and 106.
const WIDE = 160
const SIDEBAR = 42
const ROW = /^ [◇◈◆] worker gpt  Fix money parsing  /

/** The composer area: from the dock's count line to the end, left of the sidebar column. */
function composer(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  return dock < 0 ? [] : frame.slice(dock).map((line) => line.slice(0, WIDE - SIDEBAR))
}
const sidebar = (frame: ReadonlyArray<string>) => frame.map((line) => line.slice(WIDE - SIDEBAR)).join("\n")

describe.skipIf(!fork)("the subagent rows beside the sidebar in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-sidebar-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-sidebar.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `sidebar-${name}.txt`), "utf8").split("\n")
  }, 300_000)

  test("wide, the sidebar holds the session and the dock counts the worker", () => {
    for (const frame of [frames.wide, frames["wide-again"]]) {
      expect(sidebar(frame)).toContain("money worker")
      expect(composer(frame)[0]).toStartWith(" ◆ 1 subagent  ·")
    }
  })

  test("wide, with the sidebar open, the worker's row stays beneath the composer", () => {
    for (const frame of [frames.wide, frames["wide-again"]])
      expect(composer(frame)[1]?.trimEnd()).toMatch(new RegExp(`${ROW.source}Check the money parser first\\. · \\d+s$`))
  })

  test("narrow, there is no sidebar and the worker's row is back under the count", () => {
    const shown = composer(frames.narrow)
    expect(shown[0]).toStartWith(" ◆ 1 subagent  ·")
    expect(shown[1]).toMatch(new RegExp(`${ROW.source}Check the money parser first\\. · \\d+s$`))
  })
})

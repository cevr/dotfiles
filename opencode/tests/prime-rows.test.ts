// Runs scenarios/prime-rows.ts with the Prime look and the orchestrate plugin
// against an OpenCode checkout and asserts on the live subagent rows beneath
// the composer: each says its role, its unit, how it stands and what it does
// now; the update follows a worker from thinking to a shell command; a
// finished worker reads done, then its row drops. It needs OPENCODE_DEV, the
// fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-rows.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["thinking", "shell", "done", "dropped"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { thinking: [], shell: [], done: [], dropped: [] }

/** The row lines beneath the dock's count line, up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  if (dock < 0) return []
  const after = frame.slice(dock + 1)
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

const SPIN = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]"

describe.skipIf(!fork)("the live subagent rows in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-rows-"))
    const run = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-rows.ts"], {
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
    for (const name of names) frames[name] = readFileSync(join(out, `rows-${name}.txt`), "utf8").split("\n")
  }, 300_000)

  test("each running worker has a row: its role from orchestrate, its unit, a spinner, its first thought and its time", () => {
    const shown = rows(frames.thinking)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toMatch(new RegExp(`^◆ worker  Fix money parsing  ${SPIN} Check the money parser first\\. · \\d+s$`))
    expect(shown[1]).toMatch(new RegExp(`^◆ worker  Fix CSV quoting    ${SPIN} Check the CSV writer first\\. · \\d+s$`))
  })

  test("the update moves from the thought to the shell command the worker runs", () => {
    const shown = rows(frames.shell)
    expect(shown).toHaveLength(2)
    for (const line of shown) expect(line).toMatch(new RegExp(`^◆ worker  Fix .+  ${SPIN} running sleep 4 · \\d+s$`))
  })

  test("a finished worker reads done with its steps, beside the one still working", () => {
    const shown = rows(frames.done)
    expect(shown).toContain("✓ worker  Fix money parsing  done · 2 steps")
    expect(shown.find((line) => line.includes("Fix CSV quoting"))).toMatch(new RegExp(`^◆ worker  Fix CSV quoting +${SPIN} `))
  })

  test("past its linger, the finished worker's row drops and the working one stays", () => {
    const shown = rows(frames.dropped)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatch(new RegExp(`^◆ worker  Fix CSV quoting  ${SPIN} .+ · \\d+s$`))
  })
})
